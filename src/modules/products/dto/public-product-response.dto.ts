export class VariantResponseDto {
  id: string;
  sku: string;
  name: string;
  sellingPrice: number;
  customerEta?: string;
  visibility: string;
  status: string;
  salesStatus: string;
  totalStock: number;
  availableStock: number;
  lockedStock: number;
  soldStock: number;
  casing: string;
  casingDisplay: string;

  static fromEntity(v: any): VariantResponseDto {
    const dto = new VariantResponseDto();
    dto.id = v.id;
    dto.sku = v.sku;
    dto.name = v.name;
    dto.sellingPrice = Number(v.sellingPrice || 0);
    dto.customerEta = v.customerEta;
    dto.visibility = v.visibility;
    dto.status = v.status;
    dto.salesStatus = v.salesStatus;
    dto.totalStock = Number(v.totalStock || 0);
    dto.availableStock = Number(v.availableStock || 0);
    dto.lockedStock = Number(v.lockedStock || 0);
    dto.soldStock = Number(v.soldStock || 0);
    dto.casing = v.casing || '';
    dto.casingDisplay = v.casingDisplay || '';
    return dto;
  }
}

export class PublicProductResponseDto {
  id: string;
  name: string;
  brand: string;
  series: string;
  scale: string;
  price: number;
  sellingPrice: number;
  description: string;
  tags: string[];
  category: string;
  image: string;
  isPrebook: boolean;
  prebookDepositAmount?: number;
  arrivalDate?: string;
  releaseDate?: string;
  casingTypes: string[];
  availabilityState: 'IN_STOCK' | 'LOW_STOCK' | 'PREORDER' | 'COMING_SOON' | 'OUT_OF_STOCK';
  variants: VariantResponseDto[];

  static fromEntity(p: any): PublicProductResponseDto {
    const dto = new PublicProductResponseDto();
    dto.id = p.id;
    dto.name = p.name;
    dto.brand = p.brand;
    dto.series = p.series;
    dto.scale = p.scale;
    dto.description = p.description || '';
    dto.tags = p.tags || [];
    dto.category = p.category || '';
    dto.image = p.image || '';
    dto.releaseDate = p.releaseDate;
    dto.variants = (p.variants || []).map((v: any) => VariantResponseDto.fromEntity(v));

    // Fallbacks and shims for compatibility with older endpoints
    const primaryVar = dto.variants.find(v => v.casing.toUpperCase() === 'BOX') || dto.variants[0];
    dto.price = primaryVar ? primaryVar.sellingPrice : Number(p.price || p.sellingPrice || 0);
    dto.sellingPrice = primaryVar ? primaryVar.sellingPrice : Number(p.sellingPrice || p.price || 0);
    dto.isPrebook = primaryVar ? primaryVar.salesStatus === 'Preorder' : !!p.isPrebook;
    dto.prebookDepositAmount = p.prebookDepositAmount ? Number(p.prebookDepositAmount) : undefined;
    dto.arrivalDate = primaryVar ? primaryVar.customerEta : p.arrivalDate;
    dto.casingTypes = dto.variants.map(v => v.casing);

    const available = dto.variants.reduce((sum, v) => sum + v.availableStock, 0);
    if (dto.isPrebook) {
      dto.availabilityState = 'PREORDER';
    } else if (dto.releaseDate && new Date(dto.releaseDate) > new Date()) {
      dto.availabilityState = 'COMING_SOON';
    } else if (available <= 0) {
      dto.availabilityState = 'OUT_OF_STOCK';
    } else if (available <= 3) {
      dto.availabilityState = 'LOW_STOCK';
    } else {
      dto.availabilityState = 'IN_STOCK';
    }
    return dto;
  }
}
