-- Make customer_id on receipts and user_id on orders optional (nullable)
ALTER TABLE receipts ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;

-- Make email, full_name, and city on customers optional (nullable)
ALTER TABLE customers ALTER COLUMN email DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN full_name DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN city DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN city DROP DEFAULT;
