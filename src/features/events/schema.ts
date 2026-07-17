import { z } from "zod";

import {
  CURRENCY_VALUES,
  EVENT_CATEGORY_VALUES,
} from "@/config/site";

export const eventSchema = z.object({
  id: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(3),
  shortDescription: z.string().min(10),
  description: z.string().min(30),
  category: z.enum(EVENT_CATEGORY_VALUES),
  venue: z.string().min(2),
  city: z.string().min(2),
  country: z.string().min(2),
  startDate: z.string().datetime({ offset: true }),
  image: z.object({
    src: z.string().startsWith("/events/"),
    alt: z.string().min(5),
  }),
  minimumPrice: z.number().nonnegative(),
  currency: z.enum(CURRENCY_VALUES),
  organizer: z.string().min(2),
  featured: z.boolean(),
  availability: z.enum(["on-sale", "limited", "sold-out", "coming-soon"]),
});

export const eventsSchema = z.array(eventSchema);
