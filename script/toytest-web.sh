#!/bin/bash
set -e

# 루트 권한 확인
if [[ $EUID -ne 0 ]]; then
   echo "이 스크립트는 root 권한으로 실행되어야 합니다." 1>&2
   exit 1
fi

# 패키지 설치
apt update -y
apt install -y nginx wget unzip

# Nginx 리버스 프록시 설정
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
cat <<'EOF' > /etc/nginx/sites-available/default
server {
    listen 80;
    server_name $PUBLIC_IP;

    location = /jsp {
        return 301 /jsp/;
    }

    location /jsp/ {
        proxy_pass http://${appIP}:8080/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
    }
}
EOF

# Nginx 설정 적용
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# ---------------------------------------------
# CloudWatch Agent 설치 및 설정 (CPU + 메모리만)
# ---------------------------------------------

# CloudWatch Agent 설치
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
dpkg -i amazon-cloudwatch-agent.deb

# CloudWatch Agent 설정 파일 생성
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
