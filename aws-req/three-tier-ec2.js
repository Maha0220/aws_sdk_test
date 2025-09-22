import dotenv from "dotenv";
dotenv.config();

import {
  EC2Client,
  RunInstancesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSubnetsCommand,
} from "@aws-sdk/client-ec2";

// EC2 클라이언트 생성
const client = new EC2Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function createThreeTierEc2(vpcId) {
  console.log("🚀 3-Tier EC2 배포 시작");

  // 1. VPC 내 서브넷 3개 가져오기
  const { Subnets } = await client.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    })
  );
  if (!Subnets || Subnets.length < 3) {
    throw new Error("❌ 최소 3개의 Subnet이 필요합니다 (Web/App/DB 용)");
  }
  const [publicSubnet, appSubnet, dbSubnet] = Subnets;

  // 2. 보안 그룹 생성
  const { GroupId: webSg } = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: "Web-SG",
      Description: "Allow HTTP/HTTPS",
      VpcId: vpcId,
    })
  );
  const { GroupId: appSg } = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: "App-SG",
      Description: "Allow from Web-SG",
      VpcId: vpcId,
    })
  );
  const { GroupId: dbSg } = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: "DB-SG",
      Description: "Allow from App-SG",
      VpcId: vpcId,
    })
  );

  // 3. 보안 그룹 규칙 추가
  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: webSg,
      IpPermissions: [
        { IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
      ],
    })
  );
  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: appSg,
      IpPermissions: [
        { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, UserIdGroupPairs: [{ GroupId: webSg }] },
      ],
    })
  );
  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: dbSg,
      IpPermissions: [
        { IpProtocol: "tcp", FromPort: 3306, ToPort: 3306, UserIdGroupPairs: [{ GroupId: appSg }] },
      ],
    })
  );

  // 4. EC2 인스턴스 생성 (AMI ID는 서울 리전 Amazon Linux 2 예시)
  const amiId = "ami-0e9ffde1656c74c22";

  const webInstance = await client.send(
    new RunInstancesCommand({
      ImageId: amiId,
      InstanceType: "t3.micro",
      MinCount: 1,
      MaxCount: 1,
      NetworkInterfaces: [
        {
          AssociatePublicIpAddress: true,
          DeviceIndex: 0,
          SubnetId: publicSubnet.SubnetId,
          Groups: [webSg],
        },
      ],
      TagSpecifications: [
        { ResourceType: "instance", Tags: [{ Key: "Name", Value: "Web-Server" }] },
      ],
    })
  );

  const appInstance = await client.send(
    new RunInstancesCommand({
      ImageId: amiId,
      InstanceType: "t3.micro",
      MinCount: 1,
      MaxCount: 1,
      NetworkInterfaces: [
        { DeviceIndex: 0, SubnetId: appSubnet.SubnetId, Groups: [appSg] },
      ],
      TagSpecifications: [
        { ResourceType: "instance", Tags: [{ Key: "Name", Value: "App-Server" }] },
      ],
    })
  );

  const dbInstance = await client.send(
    new RunInstancesCommand({
      ImageId: amiId,
      InstanceType: "t3.micro",
      MinCount: 1,
      MaxCount: 1,
      NetworkInterfaces: [
        { DeviceIndex: 0, SubnetId: dbSubnet.SubnetId, Groups: [dbSg] },
      ],
      TagSpecifications: [
        { ResourceType: "instance", Tags: [{ Key: "Name", Value: "DB-Server" }] },
      ],
    })
  );

  console.log("✅ EC2 3-Tier 인스턴스 생성 완료");
  return { webInstance, appInstance, dbInstance };
}

// 실행
const vpcId = "vpc-xxxxxxxx"; // 👉 아까 만든 VPC ID 넣기
createThreeTierEc2(vpcId).catch(console.error);
