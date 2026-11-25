import boto3

s3 = boto3.client("s3")


def upload(key: str, data: bytes):
    s3.put_object(Bucket="assets", Key=key, Body=data)
