import { VariantResponseDto } from './public-product-response.dto.js';

export class AdminProductResponseDto {
  id: string;
  sku: string;
  name: string;
  brand: string;
  series: string;
  scale: string;
  price: number;
  purchasePrice: number;
  sellingPrice: number;
  totalStock: number;
  availableStock: number;
  lockedStock: number;
  soldStock: number;
  supplier: string;
  casingTypes: string[];
  status: string;
  isPrebook: boolean;
  prebookDepositAmount?: number;
  arrivalDate?: string;
  releaseDate?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  image?: string;
  variants: VariantResponseDto[];

  static fromEntity(p: any): AdminProductResponseDto {
    const dto = new AdminProductResponseDto();
    dto.id = p.id;
    dto.name = p.name;
    dto.brand = p.brand;
    dto.series = p.series;
    dto.scale = p.scale;
    dto.status = p.status;
    dto.releaseDate = p.releaseDate;
    dto.createdBy = p.createdBy;
    dto.updatedBy = p.updatedBy;
    dto.createdAt = p.createdAt || p.created_at;
    dto.updatedAt = p.updatedAt || p.updated_at;
    dto.image = p.image;
    dto.variants = (p.variants || []).map((v: any) => VariantResponseDto.fromEntity(v));

    // Fallbacks and aggregated metrics
    const primaryVar = dto.variants.find(v => v.casing.toUpperCase() === 'BOX') || dto.variants[0];
    dto.sku = primaryVar ? primaryVar.sku : (p.sku || '');
    dto.price = primaryVar ? primaryVar.sellingPrice : Number(p.price || p.sellingPrice || 0);
    dto.purchasePrice = Number(p.purchasePrice || 0);
    dto.sellingPrice = primaryVar ? primaryVar.sellingPrice : Number(p.sellingPrice || p.price || 0);
    
    dto.totalStock = dto.variants.reduce((sum, v) => sum + v.totalStock, 0);
    dto.availableStock = dto.variants.reduce((sum, v) => sum + v.availableStock, 0);
    dto.lockedStock = dto.variants.reduce((sum, v) => sum + v.lockedStock, 0);
    dto.soldStock = dto.variants.reduce((sum, v) => sum + v.soldStock, 0);

    dto.supplier = p.supplier || '';
    dto.casingTypes = dto.variants.map(v => v.casing);
    dto.isPrebook = primaryVar ? primaryVar.salesStatus === 'Preorder' : !!p.isPrebook;
    dto.prebookDepositAmount = p.prebookDepositAmount ? Number(p.prebookDepositAmount) : undefined;
    dto.arrivalDate = primaryVar ? primaryVar.customerEta : p.arrivalDate;

    return dto;
  }
}
