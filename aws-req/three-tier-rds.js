import {
  RunInstancesCommand,
  DescribeInstancesCommand,
  waitUntilInstanceRunning,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
} from "@aws-sdk/client-ec2";

import {
  CreateDBInstanceCommand,
  DescribeDBInstancesCommand,
  waitUntilDBInstanceAvailable,
  CreateDBSubnetGroupCommand,
} from "@aws-sdk/client-rds";

import * as dotenv from "dotenv";
dotenv.config();

// const ec2Client = new EC2Client({
//   region: process.env.AWS_REGION,
//   credentials: {
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID,
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
//   },
// });

export async function deploy3TierRds(ec2Client, rdsClient, vpcInfo) {
  try {

    const ImageId = "ami-00e73adb2e2c80366";// TODO 선택 가능하게 하기
    const KeyName = process.env.AWS_KEY_NAME;
    const WebSubnetId = vpcInfo.publicSubnets[0];
    const AppSubnetId = vpcInfo.privateSubnets[0];
    const subnetIds = vpcInfo.dbSubnets;
    
    // -----------------------
    // 0. DB 서브넷 그룹 생성
    // -----------------------
    
    const dbSubnetGroupObj = await rdsClient.send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: "my-db-subnet-group", // 고유 이름
        DBSubnetGroupDescription: "Subnet group for RDS DB in private subnets",
        SubnetIds: subnetIds, // 프라이빗 서브넷 ID 배열
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

    // -----------------------
    // 1. 보안그룹 생성
    // -----------------------

    const webSg = await ec2Client.send(
      new CreateSecurityGroupCommand({
        GroupName: "Web-SG",
        Description: "Allow HTTP/HTTPS",
        VpcId: vpcInfo.vpcId,
      })
    );
    const appSg = await ec2Client.send(
      new CreateSecurityGroupCommand({
        GroupName: "App-SG",
        Description: "Allow from Web-SG",
        VpcId: vpcInfo.vpcId,
      })
    );
    const dbSg = await ec2Client.send(
      new CreateSecurityGroupCommand({
        GroupName: "DB-SG",
        Description: "Allow from App-SG",
        VpcId: vpcInfo.vpcId,
      })
    );

    await ec2Client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: webSg.GroupId,
        IpPermissions: [
          { IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
          { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
          { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
        ],
      })
    );
    await ec2Client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: appSg.GroupId,
        IpPermissions: [
          { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, UserIdGroupPairs: [{ GroupId: webSg.GroupId }] },
          { IpProtocol: "tcp", FromPort: 3000, ToPort: 3000, UserIdGroupPairs: [{ GroupId: webSg.GroupId }] },
          { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
        ],
      })
    );
    await ec2Client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: dbSg.GroupId,
        IpPermissions: [
          { IpProtocol: "tcp", FromPort: 3306, ToPort: 3306, UserIdGroupPairs: [{ GroupId: appSg.GroupId }] },
          { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
        ],
      })
    );
    console.log("✅ 보안 그룹 및 규칙 생성 완료");

    // -----------------------
    // 2. RDS (DB) 생성
    // -----------------------
    const dbId = "mydb-" + Date.now();
    await rdsClient.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: dbId,
        AllocatedStorage: 20,
        DBInstanceClass: "db.t3.micro",
        Engine: "mysql",
        MasterUsername: "admin",
        MasterUserPassword: "password1234!",
        VpcSecurityGroupIds: [dbSg.GroupId],
        DBSubnetGroupName: DBSubnetGroupName,
        PubliclyAccessible: false,
      })
    );
    console.log("✅ DB 생성 시작:", dbId);
    console.log("⏳ Waiting for RDS to be available...");
    await waitUntilDBInstanceAvailable({ client: rdsClient, maxWaitTime: 600 }, { DBInstanceIdentifier: dbId });
    const dbInfo = await rdsClient.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbId }));
    const dbEndpoint = dbInfo.DBInstances[0].Endpoint.Address;
    console.log("✅ DB Endpoint:", dbEndpoint);

    // -----------------------
    // 3. EC2 (App)
    // -----------------------
    const userDataApp = Buffer.from(`#!/bin/bash
      # 업데이트
      apt-get update -y
      apt-get upgrade -y

      # Node.js & npm 설치 (LTS 버전)
      curl -fsSL https://deb.nodesource.com/setup_16.x | bash -
      apt-get install -y nodejs git mysql-client

      # 앱 코드 작성
      cat <<EOF > /home/ubuntu/app.js
      const http = require('http');
      const mysql = require('mysql2');
      const connection = mysql.createConnection({
        host: "${dbEndpoint}",
        user: "admin",
        password: "password1234!",
      });
      connection.connect(err => {
        if (err) {
          console.error('DB Connection Failed:', err);
        } else {
          console.log('Connected to DB');
        }
      });
      const server = http.createServer((req, res) => {
        connection.query('SELECT NOW() as now', (err, results) => {
          res.writeHead(200, {'Content-Type': 'text/plain'});
          if (err) {
            res.end("DB Error: " + err);
          } else {
            res.end("App Tier Connected! Time: " + results[0].now);
          }
        });
      });
      server.listen(3000, "0.0.0.0");
      EOF

      # 앱 실행 (ubuntu 유저 홈에서 실행)
      node /home/ubuntu/app.js > /home/ubuntu/app.log 2>&1 &
    `).toString("base64");

    const app = await ec2Client.send(
      new RunInstancesCommand({
        ImageId: ImageId,
        InstanceType: "t3.micro",
        MinCount: 1,
        MaxCount: 1,
        KeyName: KeyName,
        SecurityGroupIds: [appSg.GroupId],
        SubnetId: AppSubnetId,
        UserData: userDataApp,
      })
    );

    const appId = app.Instances[0].InstanceId;

    await waitUntilInstanceRunning({ client: ec2Client, maxWaitTime: 300 }, { InstanceIds: [appId] });
    const appInfo = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [appId] }));
    const appIP = appInfo.Reservations[0].Instances[0].PrivateIpAddress;
    console.log("✅ App 서버 Private IP:", appIP);
    console.log("✅ App 서버 생성 완료");

    // -----------------------
    // 4. EC2 (Web) - Nginx Proxy
    // -----------------------
    const userDataWeb = Buffer.from(`#!/bin/bash
      set -e

      # 시스템 업데이트
      apt-get update -y
      apt-get upgrade -y

      # Nginx 설치
      apt-get install -y nginx

      # Nginx 자동 시작 등록 및 실행
      systemctl enable nginx
      systemctl start nginx

      # Nginx Reverse Proxy 설정
      cat <<EOF > /etc/nginx/sites-available/app.conf
      server {
          listen 80;
          location / {
              proxy_pass http://${appIP}:3000;
              proxy_http_version 1.1;
              proxy_set_header Upgrade \$http_upgrade;
              proxy_set_header Connection 'upgrade';
              proxy_set_header Host \$host;
              proxy_cache_bypass \$http_upgrade;
          }
      }
      EOF

      # 설정 활성화
      ln -s /etc/nginx/sites-available/app.conf /etc/nginx/sites-enabled/app.conf

      # 기본 설정 삭제 (충돌 방지)
      rm -f /etc/nginx/sites-enabled/default

      # Nginx 설정 테스트 및 재시작
      nginx -t && systemctl reload nginx
    `).toString("base64");

    const web = await ec2Client.send(
      new RunInstancesCommand({
        ImageId: ImageId,
        InstanceType: "t3.micro",
        MinCount: 1,
        MaxCount: 1,
        KeyName: KeyName,
        SecurityGroupIds: [webSg.GroupId],
        SubnetId: WebSubnetId,
        UserData: userDataWeb,
      })
    );

    const webId = web.Instances[0].InstanceId;

    await waitUntilInstanceRunning({ client: ec2Client, maxWaitTime: 300 }, { InstanceIds: [webId] });
    const webInfo = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [webId] }));
    let webIP = webInfo.Reservations[0].Instances[0].PublicIpAddress;

    // if (!webIP) {
    //   console.log("Public IP 아직 할당 안됨, 10초 후 재조회");
    //   await new Promise(r => setTimeout(r, 5000)); // 5초 대기
    //   const retryInfo = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [webId] }));
    //   webIP = retryInfo.Reservations[0].Instances[0].PublicIpAddress;
    // }
    console.log("✅ Web 서버 Public IP:", webIP);
    console.log("✅ 3-Tier 아키텍처 배포 완료");

    // -----------------------
    // 5. 아키텍처 출력
    // -----------------------
    const diagram = `
    ┌───────────────┐
    │   Web (EC2)   │ → http://${webIP}
    └───────▲───────┘
            │ (proxy)
    ┌───────┴───────┐
    │   App (EC2)   │ → ${appIP}:3000
    └───────▲───────┘
            │
    ┌───────┴───────┐
    │   DB (RDS)    │ → ${dbEndpoint}:3306
    └───────────────┘
    `
    console.log(diagram);

    return { type: "3-tier-rds", webIP, appIP, dbEndpoint, diagram };
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

// deploy3TierRds('vpc-043958a1350e3297a').catch(console.error); // 👉 VPC ID 넣기
