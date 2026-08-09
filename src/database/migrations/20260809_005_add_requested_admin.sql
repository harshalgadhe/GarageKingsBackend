INSERT INTO users (email, role)
VALUES ('agrawalanutosh0804@gmail.com', 'Admin')
ON CONFLICT (email) DO UPDATE
SET role = 'Admin', updated_at = NOW(), deleted_at = NULL;
