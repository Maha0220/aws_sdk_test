#!/bin/bash

# warning:
# deprecated script

set -e

if [[ $EUID -ne 0 ]]; then
   echo "이 스크립트는 root 권한으로 실행되어야 합니다." 1>&2
   exit 1
fi

# MariaDB 설치
apt update -y
apt install -y mariadb-server wget unzip

systemctl enable mariadb
systemctl start mariadb

# DB 및 사용자 생성
mysql -u root <<'EOF'
CREATE DATABASE IF NOT EXISTS testdb;
GRANT ALL PRIVILEGES ON testdb.* TO 'admin'@'%' IDENTIFIED BY 'password1234!';
GRANT ALL PRIVILEGES ON testdb.* TO 'admin'@'localhost' IDENTIFIED BY 'password1234!';
FLUSH PRIVILEGES;
EOF

# 외부 접속 허용
sed -i 's/^bind-address\s*=.*/bind-address = 0.0.0.0/' /etc/mysql/mariadb.conf.d/50-server.cnf
systemctl restart mariadb

# ---------------------------------------------
# CloudWatch Agent 설치 및 설정 (CPU + 메모리만)
# ---------------------------------------------

# CloudWatch Agent 설치
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
dpkg -i amazon-cloudwatch-agent.deb

# 설정 파일 생성
cat <<'EOF' > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
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
