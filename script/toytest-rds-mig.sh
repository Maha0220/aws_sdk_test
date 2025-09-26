#!/bin/bash

set -euo pipefail  # 에러 발생 시 중단, 정의되지 않은 변수 사용 시 오류

# --- 1. 환경 변수 설정 ---
DB_NAME="your_database_name"
DB_USER="your_db_user"
DB_PASS="your_db_password"
RDS_INSTANCE_NAME="your-new-rds-instance"
RDS_MASTER_USER="admin"
RDS_MASTER_PASS="your_rds_master_password"
S3_BUCKET="your-s3-bucket-for-db-migration"
DUMP_FILE="db_dump.sql"

# --- 2. RDS 인스턴스 생성 ---
# echo "[1] RDS 인스턴스 생성 중..."
aws rds create-db-instance \
    --db-instance-identifier "$RDS_INSTANCE_NAME" \
    --db-instance-class db.t3.micro \
    --engine mysql \
    --allocated-storage 20 \
    --master-username "$RDS_MASTER_USER" \
    --master-user-password "$RDS_MASTER_PASS" \
    --no-publicly-accessible

# echo "[2] RDS 인스턴스 준비 대기 중..."
aws rds wait db-instance-available --db-instance-identifier "$RDS_INSTANCE_NAME"

RDS_ENDPOINT=$(aws rds describe-db-instances \
    --db-instance-identifier "$RDS_INSTANCE_NAME" \
    --query "DBInstances[0].Endpoint.Address" \
    --output text)

# echo "✅ RDS 엔드포인트: $RDS_ENDPOINT"

# --- 3. RDS에 접속하여 DB 생성 ---
# echo "[3] RDS에 데이터베이스 생성 중..."
mysql -h "$RDS_ENDPOINT" -u "$RDS_MASTER_USER" -p"$RDS_MASTER_PASS" -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`;"

# --- 4. EC2에서 DB 덤프 ---
# echo "[4] 로컬 DB 덤프 생성 중..."
mysqldump -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" > "$DUMP_FILE"

# --- 5. S3 업로드 (선택적) ---
# echo "[5] S3로 덤프 파일 업로드 중..."
aws s3 cp "$DUMP_FILE" "s3://$S3_BUCKET/"

# --- 6. RDS로 데이터 복원 ---
# echo "[6] RDS로 데이터 복원 중..."
mysql -h "$RDS_ENDPOINT" -u "$RDS_MASTER_USER" -p"$RDS_MASTER_PASS" "$DB_NAME" < "$DUMP_F_
