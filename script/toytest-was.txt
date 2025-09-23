#!/bin/bash
set -e

if [[ $EUID -ne 0 ]]; then
   echo "이 스크립트는 root 권한으로 실행되어야 합니다." 1>&2
   exit 1
fi

# 패키지 설치
apt update -y
apt install -y openjdk-11-jdk unzip wget

# Tomcat 설치
cd /root || exit
wget https://dlcdn.apache.org/tomcat/tomcat-10/v10.1.46/bin/apache-tomcat-10.1.46.zip
unzip apache-tomcat-10.1.46.zip
mv apache-tomcat-10.1.46 tomcat
chmod 777 -R tomcat

# MySQL 커넥터 다운로드
wget -P tomcat/lib https://repo1.maven.org/maven2/mysql/mysql-connector-java/8.0.23/mysql-connector-java-8.0.23.jar

# Tomcat 시작
sh tomcat/bin/startup.sh

# JSP 파일 자동 생성
cat <<EOF > /root/tomcat/webapps/ROOT/index.jsp
<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<%@ page import="java.sql.*" %>
<h1>DB</h1>
<%
    Connection conn = null;
    try {
        String Url = "jdbc:mysql://10.10.3.191:3306/amidb";
        String Id = "amiuser";
        String Pass = "1234";

        Class.forName("com.mysql.jdbc.Driver");
        conn = DriverManager.getConnection(Url, Id, Pass);
        out.println("was-db Connection Success!");
    } catch(Exception e) {
        e.printStackTrace();
    }
%>
EOF

# ---------------------------------------------
# CloudWatch Agent 설치 및 설정 (CPU + 메모리만)
# ---------------------------------------------
# 패키지 준비
apt install -y wget unzip

# CloudWatch Agent 설치
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
dpkg -i amazon-cloudwatch-agent.deb

# 설정 파일 생성
cat <<EOF > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
{
  "metrics": {
    "namespace": "CWAgent",
    "metrics_collected": {
      "cpu": {
        "measurement": [
          "cpu_usage_idle",
          "cpu_usage_user",
          "cpu_usage_system"
        ],
        "resources": ["*"],
        "totalcpu": true
      },
      "mem": {
        "measurement": [
          "mem_used_percent"
        ],
        "resources": ["*"]
      }
    }
  }
}
EOF

# CloudWatch Agent 실행
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s
