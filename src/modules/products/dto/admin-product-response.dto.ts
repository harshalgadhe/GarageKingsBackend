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

  static fromEntity(p: any): AdminProductResponseDto {
    const dto = new AdminProductResponseDto();
    dto.id = p.id;
    dto.sku = p.sku;
    dto.name = p.name;
    dto.brand = p.brand;
    dto.series = p.series;
    dto.scale = p.scale;
    dto.price = Number(p.price || p.sellingPrice || 0);
    dto.purchasePrice = Number(p.purchasePrice || 0);
    dto.sellingPrice = Number(p.sellingPrice || p.price || 0);
    dto.totalStock = Number(p.totalStock || 0);
    dto.availableStock = Number(p.availableStock || 0);
    dto.lockedStock = Number(p.lockedStock || 0);
    dto.soldStock = Number(p.soldStock || 0);
    dto.supplier = p.supplier || '';
    dto.casingTypes = p.casingTypes || [];
    dto.status = p.status;
    dto.isPrebook = !!p.isPrebook;
    dto.prebookDepositAmount = p.prebookDepositAmount ? Number(p.prebookDepositAmount) : undefined;
    dto.arrivalDate = p.arrivalDate;
    dto.releaseDate = p.releaseDate;
    dto.createdBy = p.createdBy;
    dto.updatedBy = p.updatedBy;
    dto.createdAt = p.createdAt || p.created_at;
    dto.updatedAt = p.updatedAt || p.updated_at;
    dto.image = p.image;
    return dto;
  }
}
