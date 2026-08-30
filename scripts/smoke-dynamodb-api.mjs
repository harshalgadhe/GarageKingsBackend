import 'dotenv/config';
import { JwtService } from '@nestjs/jwt';

const baseUrl = process.env.DYNAMODB_SMOKE_URL || 'http://localhost:5002/api/v1';
const secret = process.env.JWT_SECRET || 'local-development-only-change-before-production-2026';
const token = new JwtService({ secret }).sign({ userId: 'ddb-smoke-test', email: 'ddb-smoke@local.test', role: 'Owner' }, { expiresIn: '5m' });
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const sku = `DDB-SMOKE-${Date.now()}`;

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
};

const created = await request('/admin/products', { method: 'POST', body: JSON.stringify({
  sku, name: 'DynamoDB smoke model', brand: 'Local Test', scale: '1:64', casing: 'Box',
  sellingPrice: 1200, stock: 2, status: 'Published', images: ['https://example.com/model.webp']
}) });

let duplicateRejected = false;
try { await request('/admin/products', { method: 'POST', body: JSON.stringify({ sku, name: 'Duplicate', brand: 'Local Test' }) }); }
catch (error) { duplicateRejected = String(error.message).includes('409'); }

const updated = await request(`/admin/products/${created.id}`, { method: 'PATCH', body: JSON.stringify({ stock: 7 }) });
const publicPage = await request(`/products?search=${encodeURIComponent(sku)}`);
const lookups = await request('/admin/catalog/lookups');
await request(`/admin/products/${created.id}`, { method: 'DELETE' });
const afterDelete = await request(`/products?search=${encodeURIComponent(sku)}`);

console.log(JSON.stringify({ created: created.sku, duplicateRejected, updatedStock: updated.availableStock,
  searchable: publicPage.total === 1, brandLookup: lookups.brands.includes('Local Test'), deleted: afterDelete.total === 0 }, null, 2));
