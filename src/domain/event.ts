import type {
  EventCategory,
  SupportedCurrency,
} from "@/config/site";

export type AvailabilityStatus =
  | "on-sale"
  | "limited"
  | "sold-out"
  | "coming-soon";

export interface EventImage {
  src: string;
  alt: string;
}

export interface Event {
  id: string;
  slug: string;
  title: string;
  shortDescription: string;
  description: string;
  category: EventCategory;
  venue: string;
  city: string;
  country: string;
  startDate: string;
  image: EventImage;
  minimumPrice: number;
  currency: SupportedCurrency;
  organizer: string;
  featured: boolean;
  availability: AvailabilityStatus;
}

export interface EventFilters {
  query: string;
  category: EventCategory | "all";
  city: string;
  sort: EventSort;
}

export type EventSort = "date-asc" | "price-asc" | "price-desc";
