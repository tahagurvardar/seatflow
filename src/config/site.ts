export const SITE_CONFIG = {
  name: "SeatFlow",
  shortName: "SeatFlow",
  description:
    "Discover live events and explore the venue layouts behind memorable rooms, stages, screens, and stands.",
  tagline: "Find your place in the moment.",
  supportEmail: "hello@seatflow.example",
} as const;

export const ROUTES = {
  home: "/",
  events: "/events",
  login: "/login",
  register: "/register",
  customerDashboard: "/customer/dashboard",
  organizerDashboard: "/organizer/dashboard",
  organizerOnboarding: "/organizer/onboarding",
  venueOperatorDashboard: "/venue-operator/dashboard",
  venueOperatorOnboarding: "/venue-operator/onboarding",
  admin: "/admin",
  eventDetail: (slug: string) => `/events/${slug}` as const,
  organizerEvents: (organizationSlug: string) =>
    `/organizer/organizations/${organizationSlug}/events` as const,
  organizerNewEvent: (organizationSlug: string) =>
    `/organizer/organizations/${organizationSlug}/events/new` as const,
  organizerEvent: (organizationSlug: string, eventSlug: string) =>
    `/organizer/organizations/${organizationSlug}/events/${eventSlug}` as const,
  organizerEventEdit: (organizationSlug: string, eventSlug: string) =>
    `/organizer/organizations/${organizationSlug}/events/${eventSlug}/edit` as const,
  organizerEventSessions: (organizationSlug: string, eventSlug: string) =>
    `/organizer/organizations/${organizationSlug}/events/${eventSlug}/sessions` as const,
  organizerNewSession: (organizationSlug: string, eventSlug: string) =>
    `/organizer/organizations/${organizationSlug}/events/${eventSlug}/sessions/new` as const,
  organizerSession: (
    organizationSlug: string,
    eventSlug: string,
    sessionId: string,
  ) =>
    `/organizer/organizations/${organizationSlug}/events/${eventSlug}/sessions/${sessionId}` as const,
  organizerSessionEdit: (
    organizationSlug: string,
    eventSlug: string,
    sessionId: string,
  ) =>
    `/organizer/organizations/${organizationSlug}/events/${eventSlug}/sessions/${sessionId}/edit` as const,
  organizerSessionPricing: (
    organizationSlug: string,
    eventSlug: string,
    sessionId: string,
  ) =>
    `/organizer/organizations/${organizationSlug}/events/${eventSlug}/sessions/${sessionId}/pricing` as const,
  organizerEventPreview: (organizationSlug: string, eventSlug: string) =>
    `/organizer/organizations/${organizationSlug}/events/${eventSlug}/preview` as const,
  organizerApprovedVenues: (organizationSlug: string) =>
    `/organizer/organizations/${organizationSlug}/venues` as const,
  venueOperatorVenues: (organizationSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues` as const,
  venueOperatorNewVenue: (organizationSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues/new` as const,
  venueOperatorVenue: (organizationSlug: string, venueSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues/${venueSlug}` as const,
  venueOperatorVenueEdit: (organizationSlug: string, venueSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues/${venueSlug}/edit` as const,
  venueOperatorVenueAccess: (organizationSlug: string, venueSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues/${venueSlug}/access` as const,
  venueOperatorNewSpace: (organizationSlug: string, venueSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues/${venueSlug}/spaces/new` as const,
  venueOperatorSpace: (organizationSlug: string, venueSlug: string, spaceSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues/${venueSlug}/spaces/${spaceSlug}` as const,
  venueOperatorSpaceEdit: (organizationSlug: string, venueSlug: string, spaceSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues/${venueSlug}/spaces/${spaceSlug}/edit` as const,
  venueOperatorNewSeatMap: (organizationSlug: string, venueSlug: string, spaceSlug: string) =>
    `/venue-operator/organizations/${organizationSlug}/venues/${venueSlug}/spaces/${spaceSlug}/seat-maps/new` as const,
  venueOperatorSeatMap: (
    organizationSlug: string,
    venueSlug: string,
    spaceSlug: string,
    version: number,
  ) =>
    `/venue-operator/organizations/${organizationSlug}/venues/${venueSlug}/spaces/${spaceSlug}/seat-maps/${version}` as const,
} as const;

export const PUBLIC_ROUTES = [
  ROUTES.home,
  ROUTES.events,
  "/events/[slug]",
  ROUTES.login,
  ROUTES.register,
] as const;

export const PROTECTED_ROUTES = [
  ROUTES.customerDashboard,
  ROUTES.organizerDashboard,
  ROUTES.organizerOnboarding,
  ROUTES.venueOperatorDashboard,
  ROUTES.venueOperatorOnboarding,
  "/venue-operator/organizations/[organizationSlug]/venues",
  "/organizer/organizations/[organizationSlug]/events",
  ROUTES.admin,
] as const;

export const PLATFORM_ROLE_VALUES = ["USER", "ADMIN"] as const;
export type PlatformRole = (typeof PLATFORM_ROLE_VALUES)[number];

export const PLATFORM_ROLE_DEFINITIONS: ReadonlyArray<{
  id: PlatformRole;
  label: string;
  summary: string;
}> = [
  {
    id: "USER",
    label: "User",
    summary:
      "Every authenticated account is a customer; organization memberships add tenant capabilities.",
  },
  {
    id: "ADMIN",
    label: "Administrator",
    summary: "A server-managed platform privilege that is never set at registration.",
  },
] as const;

export const ORGANIZATION_KIND_VALUES = [
  "ORGANIZER",
  "VENUE_OPERATOR",
] as const;

export const MEMBERSHIP_ROLE_VALUES = ["OWNER", "ADMIN", "MEMBER"] as const;

export const EVENT_CATEGORY_VALUES = [
  "concert",
  "cinema",
  "theatre",
  "sport",
  "other",
] as const;

export type EventCategory = (typeof EVENT_CATEGORY_VALUES)[number];

export const EVENT_CATEGORIES: ReadonlyArray<{
  id: EventCategory;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    id: "concert",
    label: "Concerts",
    shortLabel: "Music",
    description: "Intimate sets, rising voices, and nights built around sound.",
  },
  {
    id: "cinema",
    label: "Cinema",
    shortLabel: "Film",
    description: "Premieres, restored classics, and screenings worth sharing.",
  },
  {
    id: "theatre",
    label: "Theatre",
    shortLabel: "Stage",
    description: "Bold new writing, timeless stories, and live performance.",
  },
  {
    id: "sport",
    label: "Sports",
    shortLabel: "Sport",
    description: "Big fixtures, close contests, and the energy of the crowd.",
  },
  {
    id: "other",
    label: "Other",
    shortLabel: "Other",
    description: "Talks, community programmes, and events beyond the core categories.",
  },
] as const;

export const CURRENCY_VALUES = ["AZN", "EUR", "GBP", "USD"] as const;
export type SupportedCurrency = (typeof CURRENCY_VALUES)[number];

export const NAVIGATION = [
  { label: "Discover Events", href: ROUTES.events },
  { label: "Categories", href: "/#categories" },
  { label: "For Organizers", href: "/#organizers" },
] as const;
