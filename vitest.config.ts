import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // test/fixtures 안의 *.test.ts는 분석 대상인 가짜 저장소라서 실행하지 않는다
    include: ['test/*.test.ts'],
    testTimeout: 30_000,
  },
});
