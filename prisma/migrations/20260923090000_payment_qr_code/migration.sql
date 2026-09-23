-- The Razorpay QR code a UPI_QR payment is collected through.
--
-- A QR payment has no order behind it. `qr_code.credited` carries the payment
-- entity and the QR's own id, and nothing else that ties back to us — so
-- without this column the webhook has no way to find the row it belongs to,
-- and `handleWebhook` drops the event as "no payment entity".
--
-- Unique because a single-use code belongs to exactly one collection, and a
-- second payment row claiming the same code would mean two fares settled by
-- one scan.
ALTER TABLE "Payment" ADD COLUMN "gatewayQrId" TEXT;

CREATE UNIQUE INDEX "Payment_gatewayQrId_key" ON "Payment" ("gatewayQrId");
