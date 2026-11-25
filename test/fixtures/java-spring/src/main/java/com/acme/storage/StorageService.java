package com.acme.storage;

import org.springframework.stereotype.Service;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

@Service
public class StorageService {
    private final S3Client s3;

    public StorageService(S3Client s3) {
        this.s3 = s3;
    }

    public void upload(String key, byte[] body) {
        s3.putObject(PutObjectRequest.builder().bucket("assets").key(key).build(), RequestBody.fromBytes(body));
    }
}
