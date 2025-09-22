import dotenv from 'dotenv';
dotenv.config();

import { DescribeVpcsCommand, DescribeSubnetsCommand, DescribeRouteTablesCommand, DescribeNatGatewaysCommand, DisassociateRouteTableCommand, DeleteRouteTableCommand, DeleteSubnetCommand, DeleteNatGatewayCommand, DescribeInternetGatewaysCommand, DetachInternetGatewayCommand, DeleteInternetGatewayCommand, DeleteVpcCommand, DescribeAddressesCommand, ReleaseAddressCommand, DeleteRouteCommand } from "@aws-sdk/client-ec2";

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function deleteVPC(client) {
  try {
    // 1️⃣ 삭제할 VPC 조회
    const vpcsResp = await client.send(new DescribeVpcsCommand({
      Filters: [{ Name: "tag:Name", Values: ["StableVPC", "FullVPC", "CLI_VPC"] }]
    }));

    if (vpcsResp.Vpcs.length === 0) {
      console.log("삭제할 VPC 없음");
      return;
    }

    for (const vpc of vpcsResp.Vpcs) {
      const vpcId = vpc.VpcId;
      console.log(`삭제 시작 VPC: ${vpcId}`);

      // 🔹 NAT 참조하는 라우트 삭제
      const exRtResp = await client.send(
        new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] })
      );
      for (const rt of exRtResp.RouteTables) {
        for (const route of rt.Routes) {
          if (route.NatGatewayId) {
            console.log(`라우팅 테이블 ${rt.RouteTableId} 에서 NAT 경로 제거: ${route.NatGatewayId}`, "pending");
            await client.send(new DeleteRouteCommand({
              RouteTableId: rt.RouteTableId,
              DestinationCidrBlock: route.DestinationCidrBlock
            }));
            console.log(`NAT 경로 제거 완료`, "done");
          }
        }
      }

      // 2️⃣ NAT 게이트웨이 삭제
      const natResp = await client.send(new DescribeNatGatewaysCommand({ Filter: [{ Name: "vpc-id", Values: [vpcId] }] }));
      for (const nat of natResp.NatGateways) {
        await client.send(new DeleteNatGatewayCommand({ NatGatewayId: nat.NatGatewayId }));
        console.log(`NAT 게이트웨이 삭제 시작: ${nat.NatGatewayId}`);
      }

      // // NAT 삭제 대기
      // await wait(15000);

      // 3️⃣ NAT 연동 EIP 해제
      const eipResp = await client.send(new DescribeAddressesCommand({ Filters: [{ Name: "domain", Values: ["vpc"] }] }));
      for (const eip of eipResp.Addresses) {
        if (natResp.NatGateways.some(nat => nat.NatGatewayId === eip.AssociationId || nat.NatGatewayId === eip.AllocationId)) {
          await client.send(new ReleaseAddressCommand({ AllocationId: eip.AllocationId }));
          console.log(`EIP 해제: ${eip.PublicIp}`);
        }
      }

      // 4️⃣ 라우팅 테이블 삭제
      const { RouteTables } = await client.send(new DescribeRouteTablesCommand({ Filter: [{ Name: "vpc-id", Values: [vpcId] }] }));
      if (!RouteTables) return;

      for (const rt of RouteTables) {
        // 메인 라우트 테이블은 삭제 불가
        const isMain = rt.Associations?.some(a => a.Main);
        if (isMain) continue;

        if (rt.Routes) {
          for (const route of rt.Routes) {
            if (route.GatewayId || route.NatGatewayId) {
              console.log(`🗑 Route 삭제: ${rt.RouteTableId} → ${route.DestinationCidrBlock}`);
              await client.send(new DeleteRouteCommand({ RouteTableId: rt.RouteTableId, DestinationCidrBlock: route.DestinationCidrBlock }));
            }
          }
        }

        console.log(`🗑 RouteTable 삭제: ${rt.RouteTableId}`);
        await client.send(new DeleteRouteTableCommand({ RouteTableId: rt.RouteTableId }));
      }

      // 5️⃣ 서브넷 삭제
      const subnetsResp = await client.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }));
      for (const subnet of subnetsResp.Subnets) {
        await client.send(new DeleteSubnetCommand({ SubnetId: subnet.SubnetId }));
        console.log(`서브넷 삭제: ${subnet.SubnetId}`);
      }

      // 6️⃣ IGW 삭제
      const igwResp = await client.send(new DescribeInternetGatewaysCommand({ Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }] }));
      for (const igw of igwResp.InternetGateways) {
        await client.send(new DetachInternetGatewayCommand({ InternetGatewayId: igw.InternetGatewayId, VpcId: vpcId }));
        await client.send(new DeleteInternetGatewayCommand({ InternetGatewayId: igw.InternetGatewayId }));
        console.log(`IGW 삭제: ${igw.InternetGatewayId}`);
      }

      // 7️⃣ VPC 삭제
      console.log(`VPC 삭제 시작: ${vpcId}`);
      await client.send(new DeleteVpcCommand({ VpcId: vpcId }));
      console.log(`VPC 삭제 완료: ${vpcId}`);
    }

    console.log("✅ 모든 VPC 및 관련 리소스 삭제 완료!");
  } catch (err) {
    console.error("오류 발생:", err);
  }
}
