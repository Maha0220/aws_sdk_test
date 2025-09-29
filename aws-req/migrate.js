import {
    RDSClient,
    CreateDBInstanceCommand,
    DescribeDBInstancesCommand,
  } from "@aws-sdk/client-rds";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

//DMS 기반이 아니라 mysqldump 기반 간단 방식
export async function migrateEC2ToRDS({
  rdsClient,
  vpcInfo,
  webIP,    // 웹서버 퍼블릭 IP
  appIP,    // 앱서버 프라이빗 IP
  dbSgId,     // DB 보안그룹 객체
  ec2Host,
  ec2User = 'ubuntu', //
}) {
  try {
    const dbSubnetIds = vpcInfo.dbSubnets;
    const dbName = "testdb"; // TODO: .env에 정의
    const dbUser = "admin"; // TODO: .env에 정의
    const dbPassword = "password1234!"; // TODO: .env에 정의
    const KeyName = process.env.AWS_KEY_NAME;
    const pemFilePath = path.join(__dirname,".." ,KeyName + ".pem");
    // -----------------------
    // 0. DB 서브넷 그룹 생성
    // -----------------------
    const dbSubnetGroupObj = await rdsClient.send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: "my-db-subnet-group2", // 고유 이름
        DBSubnetGroupDescription: "Subnet group for RDS DB in private subnets",
        SubnetIds: dbSubnetIds, // 프라이빗 서브넷 ID 배열
        Tags: [
          {
            Key: "Name",
            Value: "MyDBSubnetGroup",
          },
        ],
      })
    );
    const DBSubnetGroupName = dbSubnetGroupObj.DBSubnetGroup.DBSubnetGroupName;
    console.log("DB Subnet Group 생성:", DBSubnetGroupName);

    // 1. RDS 인스턴스 생성
    const dbId = "mydb-" + Date.now();
    console.log("⏳ Creating RDS instance...");
    await rdsClient.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: dbId,
        AllocatedStorage: 20,
        DBInstanceClass: "db.t3.micro",
        Engine: "mysql",
        MasterUsername: dbUser,
        MasterUserPassword: dbPassword,
        DBName: dbName,
        BackupRetentionPeriod: 1,
        VpcSecurityGroupIds: [dbSgId],
        DBSubnetGroupName: DBSubnetGroupName,
        PubliclyAccessible: false,
        MultiAZ: false, // 멀티 AZ 여부
        Port: 3306,
      })
    );

    // 2. RDS 가용 상태 대기
    console.log("✅ DB 생성 시작:", dbId);
    console.log("⏳ Waiting for RDS to be available...");
    await waitUntilDBInstanceAvailable({ client: rdsClient, maxWaitTime: 600 }, { DBInstanceIdentifier: dbId });
    const dbInfo = await rdsClient.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbId }));
    const dbEndpoint = dbInfo.DBInstances[0].Endpoint.Address;
    console.log("✅ DB Endpoint:", dbEndpoint);

    // 3. EC2 DB → RDS DB 마이그레이션 (pem 기반 ssh)
    const dumpCommand = `
      ssh -i ${pemFilePath} -o StrictHostKeyChecking=no ${ec2User}@${ec2Host} "mysqldump -u${dbUser} -p'${dbPassword}' ${dbName}" \
      | mysql -h ${dbEndpoint} -u${dbUser} -p'${dbPassword}' ${dbName}
    `;

    console.log("⏳ Migrating data from EC2 DB to RDS...");
    exec(dumpCommand, async (err, stdout, stderr) => {
      if (err) {
        console.error("❌ Migration failed:", stderr);
      } else {
        console.log("✅ Migration completed:", stdout);

        // // 4. 마이그레이션 성공 → 기존 EC2 인스턴스 삭제
        // ec2 id 필요
        // console.log("⏳ Terminating old EC2 instance:", ec2InstanceId);
        // await ec2.send(
        //   new TerminateInstancesCommand({
        //     InstanceIds: [ec2InstanceId],
        //   })
        // );

        // // 5. 종료 확인
        // let terminated = false;
        // while (!terminated) {
        //   const res = await ec2.send(
        //     new DescribeInstancesCommand({ InstanceIds: [ec2InstanceId] })
        //   );
        //   const state = res.Reservations[0].Instances[0].State.Name;
        //   console.log(`   Current state: ${state}`);
        //   if (state === "terminated") {
        //     terminated = true;
        //     console.log("✅ Old EC2 instance terminated successfully");
        //   } else {
        //     await new Promise((res) => setTimeout(res, 30000));
        //   }
        // }
      }
    });

    const diagram = `
    ┌───────────────┐
    │   Web (EC2)   │ → http://${webIP}  // publicSubnet
    └───────▲───────┘
            │ (proxy)
    ┌───────┴───────┐
    │   App (EC2)   │ → ${appIP}:8080  //privateSubnet
    └───────▲───────┘
            │
    ┌───────┴───────┐
    │   DB (RDS)    │ → ${dbEndpoint}:3306  // dbSubnet
    └───────────────┘
    `
    console.log(diagram);

    return { 
      type: "3-tier-rds", 
      dbEndpoint, 
      diagram,
      dbId
    };
  } catch (err) {
    console.error("❌ Error:", err);
  }
}