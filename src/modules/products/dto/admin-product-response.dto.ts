import { VariantResponseDto } from './public-product-response.dto.js';

class AdminVariantResponseDto extends VariantResponseDto {
  totalStock: number;
  availableStock: number;
  lockedStock: number;
  soldStock: number;

  static fromEntity(v: any): AdminVariantResponseDto {
    const dto = Object.assign(new AdminVariantResponseDto(), VariantResponseDto.fromEntity(v));
    dto.totalStock = Number(v.totalStock || 0);
    dto.availableStock = Number(v.availableStock || 0);
    dto.lockedStock = Number(v.lockedStock || 0);
    dto.soldStock = Number(v.soldStock || 0);
    return dto;
  }
}

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
  manufacturer?: string;
  isFeatured?: boolean;
  variants: AdminVariantResponseDto[];

  static fromEntity(p: any): AdminProductResponseDto {
    const dto = new AdminProductResponseDto();
    dto.id = p.id;
    dto.name = p.name;
    dto.brand = p.brand;
    dto.series = p.series;
    dto.scale = p.scale;
    dto.manufacturer = p.manufacturer || p.rarity_level || '';
    dto.status = p.status;
    dto.releaseDate = p.releaseDate;
    dto.createdBy = p.createdBy;
    dto.updatedBy = p.updatedBy;
    dto.createdAt = p.createdAt || p.created_at;
    dto.updatedAt = p.updatedAt || p.updated_at;
    dto.image = p.image;
    dto.isFeatured = p.isFeatured !== undefined ? Boolean(p.isFeatured) : Boolean(p.is_featured);
    dto.variants = (p.variants || []).map((v: any) => AdminVariantResponseDto.fromEntity(v));

    // Fallbacks and aggregated metrics
    const primaryVar = dto.variants[0];
    dto.sku = primaryVar ? primaryVar.sku : (p.sku || '');
    dto.price = primaryVar ? primaryVar.sellingPrice : Number(p.price || p.sellingPrice || 0);
    dto.purchasePrice = Number(p.purchasePrice || 0);
    dto.sellingPrice = primaryVar ? primaryVar.sellingPrice : Number(p.sellingPrice || p.price || 0);
    
    dto.totalStock = dto.variants.reduce((sum, v) => sum + v.totalStock, 0);
    dto.availableStock = dto.variants.reduce((sum, v) => sum + v.availableStock, 0);
    dto.lockedStock = dto.variants.reduce((sum, v) => sum + v.lockedStock, 0);
    dto.soldStock = dto.variants.reduce((sum, v) => sum + v.soldStock, 0);

    dto.supplier = p.supplier || '';
    dto.casingTypes = (p.casingTypes && p.casingTypes.length > 0) ? p.casingTypes : (dto.variants.length > 0 ? dto.variants.map(v => v.casing) : [p.casing || 'Blister']);
    dto.isPrebook = primaryVar ? primaryVar.salesStatus === 'Preorder' : !!p.isPrebook;
    dto.prebookDepositAmount = p.prebookDepositAmount ? Number(p.prebookDepositAmount) : undefined;
    dto.arrivalDate = primaryVar ? primaryVar.customerEta : p.arrivalDate;

    return dto;
  }
}
