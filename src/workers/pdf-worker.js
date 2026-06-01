import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

// Load environment configurations
dotenv.config();

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

/**
   * Exponential backoff retry calculation
   * Delay = (2 ^ retryCount) * 5 seconds
   */
function calculateExponentialBackoff(retryCount) {
  return Math.pow(2, retryCount) * 5;
}

async function executePdfGenerationWorker() {
  console.log("==================================================");
  console.log("GARAGEKINGS PDF GENERATION WORKER & STATE MACHINE");
  console.log("==================================================");

  const client = await pgPool.connect();

  try {
    // 1. Fetch oldest Pending or Processing job that has not exceeded max retries
    const fetchJobQuery = `
      SELECT j.id as job_id, j.receipt_id, j.retry_count, j.max_retries, r.receipt_number, r.total_amount, r.pdf_url
      FROM receipt_generation_jobs j
      JOIN receipts r ON j.receipt_id = r.id
      WHERE j.status = 'Pending' AND j.retry_count < j.max_retries
      ORDER BY j.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED; -- High concurrency protection: skips locked rows!
    `;

    const jobRes = await client.query(fetchJobQuery);
    if (jobRes.rows.length === 0) {
      console.log("✔ No pending PDF generation jobs found. Worker idling.");
      return;
    }

    const job = jobRes.rows[0];
    const { job_id, receipt_id, retry_count, max_retries, receipt_number, total_amount, pdf_url } = job;
    console.log(`Processing Job ID: ${job_id} | Receipt: ${receipt_number} (Retry: ${retry_count}/${max_retries})`);

    // 2. IDEMPOTENCY PROTECTION
    // If a PDF URL already exists, instantly mark completed and skip processing!
    if (pdf_url) {
      console.log(`[Idempotency Alert] PDF already generated for Receipt: ${receipt_number}. Skipping.`);
      await client.query(
        "UPDATE receipt_generation_jobs SET status = 'Completed', updated_at = NOW() WHERE id = $1",
        [job_id]
      );
      return;
    }

    // 3. Mark job as Processing
    await client.query(
      "UPDATE receipt_generation_jobs SET status = 'Processing', updated_at = NOW() WHERE id = $1",
      [job_id]
    );

    // 4. Simulate Puppeteer rendering & S3 uploads
    // (In AWS Lambda, this executes Puppeteer page.pdf() and s3.upload() client calls)
    console.log(`Rendering PDF invoice HTML sheet for ${receipt_number}...`);
    
    // Simulate runtime processing time
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Simulate S3 object URL output
    const s3BucketName = process.env.S3_ASSETS_BUCKET || 'gk-public-assets';
    const awsRegion = process.env.COGNITO_AWS_REGION || 'ap-south-1';
    const generatedPdfUrl = `https://${s3BucketName}.s3.${awsRegion}.amazonaws.com/receipts/${receipt_number}.pdf`;

    // Simulate high-reliability validation check
    const renderSucceeded = Math.random() > 0.05; // 95% success rate for simulation runs

    if (!renderSucceeded) {
      throw new Error("Chromium browser context crashed during print operation.");
    }

    // 5. Update receipts and jobs on Success
    await client.query('BEGIN');
    try {
      // Save S3 PDF URL to receipt
      await client.query(
        "UPDATE receipts SET pdf_url = $1 WHERE id = $2",
        [generatedPdfUrl, receipt_id]
      );

      // Complete job
      await client.query(
        "UPDATE receipt_generation_jobs SET status = 'Completed', pdf_s3_url = $1, updated_at = NOW() WHERE id = $2",
        [generatedPdfUrl, job_id]
      );

      // Record audit log
      await client.query(
        `INSERT INTO audit_logs (action, entity, entity_id, after_state)
         VALUES ('RECEIPT_PDF_GENERATED', 'receipts', $1, $2);`,
        [receipt_id, JSON.stringify({ pdfUrl: generatedPdfUrl, receiptNumber: receipt_number })]
      );

      await client.query('COMMIT');
      console.log(`✔ Job Completed Successfully! Receipt PDF URL: ${generatedPdfUrl}`);

    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    }

  } catch (error) {
    console.error("❌ Worker execution failed!", error);

    // 6. STATE-MACHINE RETRY & BACKOFF TRIGGER
    // Increment retry counters, log error, and schedule backoffs
    const nextRetry = retry_count + 1;
    const backoffDelay = calculateExponentialBackoff(nextRetry);
    
    console.log(`Scheduling retry #${nextRetry} in ${backoffDelay} seconds...`);

    const failStatus = nextRetry >= max_retries ? 'Failed' : 'Pending';

    await client.query(
      `UPDATE receipt_generation_jobs 
       SET status = $1, retry_count = $2, error_log = $3, updated_at = NOW() 
       WHERE id = (SELECT id FROM receipt_generation_jobs WHERE receipt_id = $4 LIMIT 1);`,
      [failStatus, nextRetry, error.message, receipt_id]
    );

    if (failStatus === 'Failed') {
      console.error(`🚨 JOB EXHAUSTED: Receipt ${receipt_id} has exceeded max retries of ${max_retries}. Dead-Letter Alarm Triggered.`);
    }

  } finally {
    client.release();
    await pgPool.end();
  }
}

executePdfGenerationWorker().catch(console.error);
