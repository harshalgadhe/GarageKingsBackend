import { BadRequestException } from '@nestjs/common';

export interface CreateReceiptItemDto {
  description: string;
  qty: number;
  amount: number;
  productId?: string;
}

export interface CreateReceiptDto {
  receiptNumber: string;
  customerId: string;
  formatType?: string;
  taxPercent?: number;
  shippingCharges?: number;
  advancePaid?: number;
  footerNote?: string;
  items: CreateReceiptItemDto[];
  customerName?: string;
  customerPhone?: string;
  customerInstagram?: string;
  customerAddress?: string;
}

export interface VoidReceiptDto {
  reason: string;
}

export function validateCreateReceipt(dto: CreateReceiptDto) {
  if (!dto || !dto.receiptNumber?.trim()) throw new BadRequestException('Receipt number is required.');
  if (dto.receiptNumber.trim().length > 100) throw new BadRequestException('Receipt number must be 100 characters or fewer.');
  if (!Array.isArray(dto.items) || dto.items.length === 0 || dto.items.length > 100) {
    throw new BadRequestException('A receipt must contain between 1 and 100 line items.');
  }
  for (const item of dto.items) {
    const qty = Number(item?.qty);
    const amount = Number(item?.amount);
    if (!item?.description?.trim() || item.description.trim().length > 500) {
      throw new BadRequestException('Every line item needs a valid description.');
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      throw new BadRequestException(`Invalid quantity for "${item.description}".`);
    }
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) {
      throw new BadRequestException(`Invalid amount for "${item.description}".`);
    }
  }
  for (const [label, value] of [
    ['tax percentage', dto.taxPercent],
    ['shipping charges', dto.shippingCharges],
    ['advance paid', dto.advancePaid]
  ] as const) {
    if (value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      throw new BadRequestException(`Invalid ${label}.`);
    }
  }
}

export function validateVoidReceipt(dto: VoidReceiptDto) {
  const reason = dto?.reason?.trim();
  if (!reason || reason.length < 5 || reason.length > 500) {
    throw new BadRequestException('A void reason between 5 and 500 characters is required.');
  }
  return reason;
}
