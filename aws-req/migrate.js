import {
  RDSClient,
    CreateDBInstanceCommand,
    DescribeDBInstancesCommand,
  } from "@aws-sdk/client-rds";
  import {
    EC2Client,
    TerminateInstancesCommand,
    DescribeInstancesCommand,
  } from "@aws-sdk/client-ec2";
  import { exec } from "child_process";

  //DMS 기반이 아니라 mysqldump 기반 간단 방식

  const region = "ap-northeast-2"; // 서울 리전
  const rds = new RDSClient({ region });
  const ec2 = new EC2Client({ region });

async function migrateEC2ToRDS({
  rdsInstanceId,
  dbName,
  dbUser,
  dbPassword,
  ec2InstanceId,
  ec2Host,
  ec2User,
  pemFilePath, // PEM 키 파일 경로
}) {
  try {
    // 1. RDS 인스턴스 생성
    console.log("⏳ Creating RDS instance...");
    await rds.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: rdsInstanceId,
        AllocatedStorage: 20,
        DBInstanceClass: "db.t3.micro",
        Engine: "mysql",
        MasterUsername: dbUser,
        MasterUserPassword: dbPassword,
        DBName: dbName,
        BackupRetentionPeriod: 1,
        PubliclyAccessible: true,
      })
    );

    // 2. RDS 가용 상태 대기
    let endpoint = null;
    while (!endpoint) {
      console.log("⏳ Waiting for RDS to be available...");
      const result = await rds.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: rdsInstanceId,
        })
      );
      const db = result.DBInstances[0];
      if (db.DBInstanceStatus === "available") {
        endpoint = db.Endpoint.Address;
        console.log("✅ RDS available at:", endpoint);
      } else {
        await new Promise((res) => setTimeout(res, 60000)); // 1분 대기
      }
    }

    // 3. EC2 DB → RDS DB 마이그레이션 (pem 기반 ssh)
    const dumpCommand = `
      ssh -i ${pemFilePath} -o StrictHostKeyChecking=no ${ec2User}@${ec2Host} "mysqldump -u${dbUser} -p'${dbPassword}' ${dbName}" \
      | mysql -h ${endpoint} -u${dbUser} -p'${dbPassword}' ${dbName}
    `;

    console.log("⏳ Migrating data from EC2 DB to RDS...");
    exec(dumpCommand, async (err, stdout, stderr) => {
      if (err) {
        console.error("❌ Migration failed:", stderr);
      } else {
        console.log("✅ Migration completed:", stdout);

        // 4. 마이그레이션 성공 → 기존 EC2 인스턴스 삭제
        console.log("⏳ Terminating old EC2 instance:", ec2InstanceId);
        await ec2.send(
          new TerminateInstancesCommand({
            InstanceIds: [ec2InstanceId],
          })
        );

        // 5. 종료 확인
        let terminated = false;
        while (!terminated) {
          const res = await ec2.send(
            new DescribeInstancesCommand({ InstanceIds: [ec2InstanceId] })
          );
          const state = res.Reservations[0].Instances[0].State.Name;
          console.log(`   Current state: ${state}`);
          if (state === "terminated") {
            terminated = true;
            console.log("✅ Old EC2 instance terminated successfully");
          } else {
            await new Promise((res) => setTimeout(res, 30000));
          }
        }
      }
    });
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

// 실행 예시
migrateEC2ToRDS({
  rdsInstanceId: "my-rds-db",
  dbName: "testdb",
  dbUser: "admin",
  dbPassword: "password1234!",
  ec2InstanceId: "i-0abcd1234ef567890", // 삭제할 EC2 인스턴스 ID
  ec2Host: "10.0.10.45",                // EC2 DB 서버 프라이빗 IP or 퍼블릭 IP
  ec2User: "ubuntu",                    // EC2 접속 유저
  pemFilePath: "/home/ubuntu/mykey.pem", // 로컬 pem 키 파일 경로
});
