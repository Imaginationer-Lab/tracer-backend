using Amazon.S3;
using Amazon.S3.Model;

namespace DemoStore.Services;

public class StorageService
{
    private readonly IAmazonS3 _s3;

    public StorageService(IAmazonS3 s3)
    {
        _s3 = s3;
    }

    public Task UploadAsync(string key, Stream body) =>
        _s3.PutObjectAsync(new PutObjectRequest { BucketName = "assets", Key = key, InputStream = body });
}
