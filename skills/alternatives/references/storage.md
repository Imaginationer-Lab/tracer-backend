# 분류별 참고: 파일 저장 (storage)

## 호환 API 계열 (drop-in 후보)
- **S3 호환**: Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Wasabi, MinIO(직접 운영), Supabase Storage(S3 프로토콜, 일부 기능만). AWS SDK를 그대로 쓰고 `endpoint`·키·리전만 바꾼다.
  - R2는 리전을 `auto`로 둔다. MinIO는 대개 `forcePathStyle: true`가 필요하다.
  - 서명 URL(presigned)·멀티파트 업로드는 대부분 된다. 객체 ACL, 버킷 정책, S3 이벤트 알림, Object Lock, 스토리지 클래스는 서비스마다 다르다 → `partial`/`no`로 적는다.
- **Google Cloud Storage**: XML API가 S3와 상호 호환(HMAC 키)이지만 완전하지 않다. S3 SDK로 쓰면 `partial`.

## 고칠 때 보는 것
- 코드가 `new S3Client({ region })`만 하고 endpoint가 없으면 설정에 endpoint를 더해야 한다 → `settings`에 "S3 endpoint".
- 공개 URL을 `https://<bucket>.s3.amazonaws.com/...`처럼 코드에 직접 만들면 그 줄은 고쳐야 한다 → `editUses`.
- Firebase Storage·Cloudinary·Uploadcare처럼 자체 SDK를 쓰는 코드는 S3 계열로 옮기면 `rewrite`.
