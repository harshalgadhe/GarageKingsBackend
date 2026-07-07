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

  static fromEntity(p: any): PublicProductResponseDto {
    const dto = new PublicProductResponseDto();
    dto.id = p.id;
    dto.name = p.name;
    dto.brand = p.brand;
    dto.series = p.series;
    dto.scale = p.scale;
    dto.price = Number(p.price || p.sellingPrice || 0);
    dto.sellingPrice = Number(p.sellingPrice || p.price || 0);
    dto.description = p.description || '';
    dto.tags = p.tags || [];
    dto.category = p.category || '';
    dto.image = p.image || '';
    dto.isPrebook = !!p.isPrebook;
    dto.prebookDepositAmount = p.prebookDepositAmount ? Number(p.prebookDepositAmount) : undefined;
    dto.arrivalDate = p.arrivalDate;
    dto.releaseDate = p.releaseDate;
    dto.casingTypes = p.casingTypes || [];

    const available = Number(p.availableStock || 0);
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
