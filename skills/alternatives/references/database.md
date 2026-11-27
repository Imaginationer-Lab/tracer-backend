# 분류별 참고: 데이터베이스 (database)

## 호환 계열 (drop-in 후보)
- **PostgreSQL 와이어 호환**: Neon, Supabase(Postgres), AWS RDS·Aurora PostgreSQL, Google Cloud SQL, Crunchy Bridge, 직접 운영 Postgres. 연결 문자열만 바꾼다. 확장(PostGIS, pgvector)은 지원 여부를 본다.
- **MySQL 호환**: PlanetScale, TiDB Cloud, AWS RDS·Aurora MySQL. PlanetScale은 외래 키 등 제약이 있을 수 있다.
- **Redis 프로토콜**: Upstash Redis, Valkey, Dragonfly, AWS ElastiCache. 연결 주소만 바꾼다. Upstash REST SDK를 쓰는 코드는 일반 Redis로 옮기면 `rewrite`.
- **MongoDB 와이어**: MongoDB Atlas, Azure Cosmos DB for MongoDB, AWS DocumentDB(일부 연산 미지원 → `partial`).

## 고칠 때 보는 것
- Supabase를 `supabase-js`(PostgREST·실시간·스토리지)로 쓰면 DB만 다른 Postgres로 옮겨도 그 호출은 고쳐야 한다. PostgREST를 직접 운영하면 일부 유지된다.
- Firebase Firestore·DynamoDB처럼 전용 API를 쓰는 코드는 `rewrite`.
