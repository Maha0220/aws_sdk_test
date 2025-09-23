import dotenv from 'dotenv';
dotenv.config();

import {
  EC2Client,
  DescribeAvailabilityZonesCommand,
  CreateVpcCommand,
  CreateSubnetCommand,
  CreateInternetGatewayCommand,
  AttachInternetGatewayCommand,
  CreateRouteTableCommand,
  CreateRouteCommand,
  AssociateRouteTableCommand,
  AllocateAddressCommand,
  CreateNatGatewayCommand,
  DescribeNatGatewaysCommand
} from "@aws-sdk/client-ec2";

// NAT 게이트웨이 상태 확인
async function waitForNatReady(ec2Client, natGatewayId) {
  console.log(`NAT 게이트웨이 상태 대기: ${natGatewayId}`);
  while (true) {
    const resp = await ec2Client.send(new DescribeNatGatewaysCommand({ NatGatewayIds: [natGatewayId] }));
    const state = resp.NatGateways[0].State;
    console.log(`현재 상태: ${state}`);
    if (state === 'available') break;
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log("NAT 게이트웨이 준비 완료 ✅");
}

export async function setVPC(ec2Client) {
  try {
    // 1️⃣ 가용 영역 조회 (최대 2개)
    const azResp = await ec2Client.send(new DescribeAvailabilityZonesCommand({}));
    const availabilityZones = azResp.AvailabilityZones.slice(0, 2).map(az => az.ZoneName);
    console.log("사용할 AZ:", availabilityZones);

    // 2️⃣ VPC 생성
    const vpcResp = await ec2Client.send(new CreateVpcCommand({
      CidrBlock: "10.0.0.0/16",
      TagSpecifications: [{ ResourceType: "vpc", Tags: [{ Key: "Name", Value: "FullVPC" }] }]
    }));
    const vpcId = vpcResp.Vpc.VpcId;
    console.log("VPC 생성:", vpcId);

    // 3️⃣ 인터넷 게이트웨이 생성 및 연결
    const igwResp = await ec2Client.send(new CreateInternetGatewayCommand({
      TagSpecifications: [{ ResourceType: "internet-gateway", Tags: [{ Key: "Name", Value: "FullIGW" }] }]
    }));
    const igwId = igwResp.InternetGateway.InternetGatewayId;
    await ec2Client.send(new AttachInternetGatewayCommand({ VpcId: vpcId, InternetGatewayId: igwId }));
    console.log("IGW 생성 및 연결:", igwId);

    // 4️⃣ 퍼블릭 & 프라이빗 서브넷 + 라우팅 테이블 생성
    const publicSubnets = [];
    const privateSubnets = [];

    for (let i = 0; i < availabilityZones.length; i++) {
      // 퍼블릭 서브넷
      const pubSubnet = await ec2Client.send(new CreateSubnetCommand({
        VpcId: vpcId,
        CidrBlock: `10.0.${i}.0/24`,
        AvailabilityZone: availabilityZones[i],
        TagSpecifications: [{ ResourceType: "subnet", Tags: [{ Key: "Name", Value: `PublicSubnet-${i+1}` }] }]
      }));
      publicSubnets.push(pubSubnet.Subnet.SubnetId);
      console.log(`퍼블릭 서브넷 생성: ${pubSubnet.Subnet.SubnetId}`);

      const pubRT = await ec2Client.send(new CreateRouteTableCommand({
        VpcId: vpcId,
        TagSpecifications: [{ ResourceType: "route-table", Tags: [{ Key: "Name", Value: `PublicRT-${i+1}` }] }]
      }));
      await ec2Client.send(new CreateRouteCommand({ RouteTableId: pubRT.RouteTable.RouteTableId, DestinationCidrBlock: "0.0.0.0/0", GatewayId: igwId }));
      await ec2Client.send(new AssociateRouteTableCommand({ RouteTableId: pubRT.RouteTable.RouteTableId, SubnetId: pubSubnet.Subnet.SubnetId }));
      console.log(`퍼블릭 라우팅 테이블 연결 완료`);

      // 프라이빗 서브넷
      const privSubnet = await ec2Client.send(new CreateSubnetCommand({
        VpcId: vpcId,
        CidrBlock: `10.0.${i+100}.0/24`, // 프라이빗은 100+ 영역
        AvailabilityZone: availabilityZones[i],
        TagSpecifications: [{ ResourceType: "subnet", Tags: [{ Key: "Name", Value: `PrivateSubnet-${i+1}` }] }]
      }));
      privateSubnets.push(privSubnet.Subnet.SubnetId);
      console.log(`프라이빗 서브넷 생성: ${privSubnet.Subnet.SubnetId}`);
    }

    // 5️⃣ NAT 게이트웨이 생성 (첫 번째 퍼블릭 서브넷 사용)
    const eipResp = await ec2Client.send(new AllocateAddressCommand({ Domain: "vpc" }));
    const natResp = await ec2Client.send(new CreateNatGatewayCommand({ SubnetId: publicSubnets[0], AllocationId: eipResp.AllocationId }));
    const natGatewayId = natResp.NatGateway.NatGatewayId;
    
    // NAT 상태 대기
    await waitForNatReady(ec2Client, natGatewayId);
    
    console.log("NAT 게이트웨이 생성:", natGatewayId);

    // 6️⃣ 프라이빗 서브넷용 라우팅 테이블 생성 및 NAT 연결
    for (let i = 0; i < privateSubnets.length; i++) {
      const privRT = await ec2Client.send(new CreateRouteTableCommand({
        VpcId: vpcId,
        TagSpecifications: [{ ResourceType: "route-table", Tags: [{ Key: "Name", Value: `PrivateRT-${i+1}` }] }]
      }));
      await ec2Client.send(new CreateRouteCommand({ RouteTableId: privRT.RouteTable.RouteTableId, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: natGatewayId }));
      await ec2Client.send(new AssociateRouteTableCommand({ RouteTableId: privRT.RouteTable.RouteTableId, SubnetId: privateSubnets[i] }));
      console.log(`프라이빗 라우팅 테이블 연결 완료: ${privateSubnets[i]}`);
    }

    console.log("✅ 멀티 AZ VPC 환경 구축 완료!");
    return { vpcId, publicSubnets, privateSubnets };
  } catch (err) {
    console.error("오류 발생:", err);
  }
}