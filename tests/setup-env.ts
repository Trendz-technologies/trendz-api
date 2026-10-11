// Runs before every test file, before any application module is imported.
// Points the app at the isolated test database and Redis DB 1.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://trendz:trendz_local_pw@127.0.0.1:5432/trendz_test?schema=public&connect_timeout=30";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6390/1";
process.env.JWT_SECRET = "test-jwt-secret-test-jwt-secret-test-jwt-secret";
process.env.OTP_SECRET = "test-otp-secret-test-otp-secret-test-otp-secret";
process.env.PAYMENT_PROVIDER = "mock";
process.env.SMS_PROVIDER = "console";
process.env.SHIPPING_PROVIDER = "mock";
// Images go to the local MinIO bucket whatever the developer's .env says, so a test run never writes to a real Cloudinary account.
process.env.STORAGE_PROVIDER = "r2";
process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";
process.env.WEB_URL = "http://localhost:3100";
process.env.COOKIE_SECURE = "false";
