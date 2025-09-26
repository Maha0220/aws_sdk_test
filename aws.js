// This is used for getting user input.
import { createInterface } from "node:readline/promises";
import dotenv from 'dotenv';
import { setVPC } from './aws-req/set-vpc.js';
import { deploy3TierRds } from './aws-req/three-tier-rds.js';
dotenv.config();

import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  paginateListObjectsV2,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { 
  DescribeSecurityGroupsCommand, 
  EC2Client, 
} from "@aws-sdk/client-ec2";
import {
  RDSClient,
} from "@aws-sdk/client-rds";

// configuration for AWS SDK

const region = process.env.AWS_REGION;
const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
const configuration = { region, credentials };

//set up client
const s3Client = new S3Client(configuration);
const ec2Client = new EC2Client(configuration);
const rdsClient = new RDSClient(configuration);
//function

export async function s3test() {
  const bucketName = `test-bucket-${Date.now()}`;
  await s3Client.send(
    new CreateBucketCommand({
      Bucket: bucketName,
    }),
  );

  // Put an object into an Amazon S3 bucket.
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: "my-first-object.txt",
      Body: "Hello JavaScript SDK!",
    }),
  );

  // Read the object.
  const { Body } = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: "my-first-object.txt",
    }),
  );

  console.log(await Body.transformToString());

  // Confirm resource deletion.
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const result = await prompt.question("Empty and delete bucket? (y/n) ");
  prompt.close();

  if (result === "y") {
    // Create an async iterator over lists of objects in a bucket.
    const paginator = paginateListObjectsV2(
      { client: s3Client },
      { Bucket: bucketName },
    );
    for await (const page of paginator) {
      const objects = page.Contents;
      if (objects) {
        // For every object in each page, delete it.
        for (const object of objects) {
          await s3Client.send(
            new DeleteObjectCommand({ Bucket: bucketName, Key: object.Key }),
          );
        }
      }
    }

    // Once all the objects are gone, the bucket can be deleted.
    await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
  }
}
export const ec2test = async () => {
  try {
    const { SecurityGroups } = await ec2Client.send(
      new DescribeSecurityGroupsCommand({}),
    );

    const securityGroupList = SecurityGroups.slice(0, 9)
      .map((sg) => ` • ${sg.GroupId}: ${sg.GroupName}`)
      .join("\n");

    console.log(
      "Hello, Amazon EC2! Let's list up to 10 of your security groups:",
    );
    console.log(securityGroupList);
  } catch (err) {
    console.error(err);
  }
};

async function main() {
  console.log("AWS SDK for JavaScript v3 - Amazon S3 example");
  await setVPC(ec2Client);
  // await deleteVPC(ec2Client);
}

export const setAwsVpc = async () => {
  return await setVPC(ec2Client);
}

export const create3TierRds = async (vpcInfo) => {
  return await deploy3TierRds(ec2Client, rdsClient, vpcInfo);
}