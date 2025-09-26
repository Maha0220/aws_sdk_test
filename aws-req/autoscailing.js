import {
  CreateLaunchTemplateCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";
import {
  ElasticLoadBalancingV2Client,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  CreateListenerCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  AutoScalingClient,
  CreateAutoScalingGroupCommand,
} from "@aws-sdk/client-auto-scaling";

export async function deployASWeb(ec2Client, elbClient, asClient, vpcInfo) {
  try {
    // 1. Launch Template 생성 (웹서버 UserData 포함)
    const userDataScript = Buffer.from(`#!/bin/bash
      apt-get update -y
      apt-get install -y nginx
      echo "<h1>Web Server via ALB + ASG</h1>" > /var/www/html/index.html
      systemctl enable nginx
      systemctl start nginx
    `).toString("base64");

    const webSg = await ec2Client.send(
      new CreateSecurityGroupCommand({
        GroupName: "Web-SG",
        Description: "Allow from Alb-SG",
        VpcId: vpcInfo.vpcId,
      })
    );
    const albSg = await ec2Client.send(
      new CreateSecurityGroupCommand({
        GroupName: "Alb-SG",
        Description: "Allow HTTP/HTTPS",
        VpcId: vpcInfo.vpcId,
      })
    );
    await ec2Client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: webSg.GroupId,
        IpPermissions: [
          { IpProtocol: "tcp", FromPort: 80, ToPort: 80, UserIdGroupPairs: [{ GroupId: albSg.GroupId }] },
        ],
      })
    );
    await ec2Client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: albSg.GroupId,
        IpPermissions: [
          { IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
          { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
          { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
        ],
      })
    );

    const launchTemplate = await ec2Client.send(
      new CreateLaunchTemplateCommand({
        LaunchTemplateName: "webserver-template",
        LaunchTemplateData: {
          ImageId: "ami-00e73adb2e2c80366", // Ubuntu 22.04 (서울 리전 예시)
          InstanceType: "t3.micro",
          SecurityGroupIds: [webSg.GroupId],
          UserData: userDataScript,
        },
      })
    );
    const launchTemplateId = launchTemplate.LaunchTemplate.LaunchTemplateId;
    console.log("✅ Launch Template created:", launchTemplateId);

    // 2. Target Group 생성
    const targetGroup = await elbClient.send(
      new CreateTargetGroupCommand({
        Name: "web-tg",
        Protocol: "HTTP",
        Port: 80,
        VpcId: vpcInfo.vpcId,
        TargetType: "instance",
        HealthCheckProtocol: "HTTP",
        HealthCheckPath: "/",
      })
    );
    const targetGroupArn = targetGroup.TargetGroups[0].TargetGroupArn;
    console.log("✅ Target Group created:", targetGroupArn);

    // 3. ALB 생성
    const alb = await elbClient.send(
      new CreateLoadBalancerCommand({
        Name: "web-alb",
        Subnets: vpcInfo.publicSubnets,
        SecurityGroups: [albSg.GroupId],
        Scheme: "internet-facing",
        Type: "application",
        IpAddressType: "ipv4",
      })
    );
    const albArn = alb.LoadBalancers[0].LoadBalancerArn;
    console.log("✅ ALB created:", albArn);

    // 4. Listener 생성 (HTTP → Target Group)
    const listener = await elbClient.send(
      new CreateListenerCommand({
        LoadBalancerArn: albArn,
        Protocol: "HTTP",
        Port: 80,
        DefaultActions: [{ Type: "forward", TargetGroupArn: targetGroupArn }],
      })
    );
    console.log("✅ Listener created:", listener.Listeners[0].ListenerArn);

    // 5. Auto Scaling Group 생성
    await asClient.send(
      new CreateAutoScalingGroupCommand({
        AutoScalingGroupName: "web-asg",
        MinSize: 2,
        MaxSize: 4,
        DesiredCapacity: 2,
        VPCZoneIdentifier: vpcInfo.privateSubnets.join(","), // Subnet 목록
        TargetGroupARNs: [targetGroupArn],
        LaunchTemplate: {
          LaunchTemplateId: launchTemplateId,
          Version: "$Latest",
        },
      })
    );
    console.log("✅ Auto Scaling Group created: web-asg");

    return {
      type: "auto-scaling-web",
      albDns: alb.LoadBalancers[0].DNSName,
      diagram: `
      [Internet] --> [ALB (web-alb)]
      [ALB] --> [Auto Scaling Group (web-asg)]
      [Auto Scaling Group] --> [EC2 Instances (webserver-template)]
      Security Groups:
      - Alb-SG: Allow HTTP/HTTPS from anywhere
      - Web-SG: Allow HTTP from Alb-SG
      `,
    };
  } catch (err) {
    console.error("❌ Error deploying Web Tier:", err);
  }
}