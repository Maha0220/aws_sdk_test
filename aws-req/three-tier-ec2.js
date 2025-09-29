import {
  RunInstancesCommand,
  DescribeInstancesCommand,
  waitUntilInstanceRunning,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
} from "@aws-sdk/client-ec2";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import * as dotenv from "dotenv";
dotenv.config();


// const ec2Client = new EC2Client({
  //   region: process.env.AWS_REGION,
  //   credentials: {
    //     accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    //     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    //   },
    // });
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
    
export async function deploy3TierEc2(ec2Client, vpcInfo) {
  try {

    const ImageId = "ami-00e73adb2e2c80366";// TODO 선택 가능하게 하기
    const KeyName = process.env.AWS_KEY_NAME;
    const WebSubnetId = vpcInfo.publicSubnets[0];
    const AppSubnetId = vpcInfo.privateSubnets[0];
    const DBSubnetId = vpcInfo.dbSubnets[0];
    
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
    // 2. EC2 (DB) 생성
    // -----------------------
    const DB_USER_DATA = path.join(__dirname,"..", "script" ,"toytest-db.sh");
    let userDataDB = fs.readFileSync(DB_USER_DATA, "utf-8");
    userDataDB = Buffer.from(userDataDB).toString("base64");

    const db = await ec2Client.send(
      new RunInstancesCommand({
        ImageId: ImageId,
        InstanceType: "t3.micro",
        MinCount: 1,
        MaxCount: 1,
        KeyName: KeyName,
        SecurityGroupIds: [dbSg.GroupId],
        SubnetId: DBSubnetId,
        UserData: userDataDB,
      })
    );

    const dbId = db.Instances[0].InstanceId;

    await waitUntilInstanceRunning({ client: ec2Client, maxWaitTime: 300 }, { InstanceIds: [dbId] });
    const dbInfo = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [dbId] }));
    const dbIP = dbInfo.Reservations[0].Instances[0].PrivateIpAddress;
    console.log("✅ DB 서버 Private IP:", dbIP);
    console.log("✅ DB 서버 생성 완료");

    const dbEndpoint = dbIP;
    console.log("✅ DB Endpoint:", dbEndpoint);

    // -----------------------
    // 3. EC2 (App)
    // -----------------------
    
    const APP_USER_DATA = path.join(__dirname,"..", "script" ,"toytest-was.sh");
    let userDataApp = fs.readFileSync(APP_USER_DATA, "utf-8");
    userDataApp = userDataApp.replace("${dbEndpoint}", dbEndpoint);
    userDataApp = Buffer.from(userDataApp).toString("base64");

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

    const WEB_USER_DATA = path.join(__dirname,"..", "script" ,"toytest-web.sh");
    let userDataWeb = fs.readFileSync(WEB_USER_DATA, "utf-8");
    userDataWeb = userDataWeb.replace("${appIP}", appIP);
    userDataWeb = Buffer.from(userDataWeb).toString("base64");

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
    │   Web (EC2)   │ → http://${webIP}  // publicSubnet
    └───────▲───────┘
            │ (proxy)
    ┌───────┴───────┐
    │   App (EC2)   │ → ${appIP}:8080  //privateSubnet
    └───────▲───────┘
            │
    ┌───────┴───────┐
    │   DB (EC2)    │ → ${dbEndpoint}:3306  // dbSubnet
    └───────────────┘
    `
    console.log(diagram);

    return { 
      type: "3-tier-ec2db", 
      webIP, 
      appIP, 
      dbEndpoint, 
      diagram, 
      webSgId: webSg.GroupId,
      appSgId: appSg.GroupId,
      dbSgId: dbSg.GroupId,
      webId,
      appId,
      dbId
    };
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

// deploy3TierRds('vpc-043958a1350e3297a').catch(console.error); // 👉 VPC ID 넣기
