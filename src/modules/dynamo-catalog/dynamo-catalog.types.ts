export const DEFAULT_APP_SETTINGS = {
  storageDriver: 'postgres',
  showSoldOutProducts: true,
  marketplaceMobileInitialPageSize: 5,
  marketplaceDesktopInitialPageSize: 12
};

export type CatalogProduct = {
  id: string; sku?: string | null; brand: string; name: string;
  series?: string; scale?: string; casing?: string; category?: string;
  description?: string; tags?: string[]; price: number; purchasePrice: number; stock: number;
  isPrebook: boolean; deposit: number; status: string; isFeatured: boolean;
  showOnHomepage: boolean; customerEta?: string | null;
  maxQtyPerCustomer?: number | null; images: string[];
  createdAt: string; updatedAt: string; deletedAt?: string | null;
};
