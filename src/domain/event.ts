import type {
  EventCategory,
  SupportedCurrency,
} from "@/config/site";

export type AvailabilityStatus =
  | "on-sale"
  | "scheduled"
  | "sales-paused";

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
  space: string;
  city: string;
  country: string;
  timeZone: string;
  startDate: string;
  image: EventImage;
  minimumPriceMinor: number;
  currency: SupportedCurrency;
  organizer: string;
  availability: AvailabilityStatus;
  sellableCapacity: number;
}

export interface PublicEventSession {
  id: string;
  startDate: string;
  endDate: string;
  salesStartDate: string;
  salesEndDate: string;
  venue: string;
  space: string;
  city: string;
  country: string;
  timeZone: string;
  minimumPriceMinor: number;
  currency: SupportedCurrency;
  availability: AvailabilityStatus;
  sellableCapacity: number;
  seatMap: {
    id: string;
    name: string;
    version: number;
    sections: Array<{
      id: string;
      name: string;
      code: string;
      rows: Array<{
        id: string;
        label: string;
        seats: Array<{
          id: string;
          label: string;
          x: number;
          y: number;
          type: "STANDARD" | "ACCESSIBLE" | "COMPANION" | "PREMIUM";
          state: "ACTIVE" | "BLOCKED";
        }>;
      }>;
    }>;
  };
}

export interface PublicEventDetail extends Event {
  sessions: PublicEventSession[];
}

export interface EventFilters {
  query: string;
  category: EventCategory | "all";
  city: string;
  sort: EventSort;
}

export type EventSort = "date-asc" | "price-asc" | "price-desc";
