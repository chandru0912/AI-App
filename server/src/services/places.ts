import { config } from '../config.js';
import { ApiError, notConfigured } from '../lib/errors.js';

export const SERVICE_CATEGORIES = {
  tutor: 'home tutor for school students',
  electrician: 'electrician',
  plumber: 'plumber',
  ac_repair: 'AC repair service',
  mechanic: 'car and bike mechanic',
  appliance_repair: 'home appliance repair service',
  cleaning: 'home cleaning service',
  household_help: 'household helper maid service',
} as const;

export type ServiceCategory = keyof typeof SERVICE_CATEGORIES;

export interface ServiceProvider {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  rating: number | null;
  reviewCount: number;
  mapsUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  reviews: Array<{ author: string; rating: number | null; text: string; when: string }>;
}

interface PlacesResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    rating?: number;
    userRatingCount?: number;
    googleMapsUri?: string;
    location?: { latitude?: number; longitude?: number };
    reviews?: Array<{
      text?: { text?: string };
      rating?: number;
      relativePublishTimeDescription?: string;
      authorAttribution?: { displayName?: string };
    }>;
  }>;
  error?: { message?: string; status?: string };
}

const fieldMask = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.location',
  'places.reviews',
].join(',');

export async function searchNearby(input: {
  latitude: number;
  longitude: number;
  category: ServiceCategory;
  radius?: number;
  language?: string;
}): Promise<ServiceProvider[]> {
  if (!config.GOOGLE_PLACES_API_KEY) {
    throw notConfigured('Local service discovery', 'GOOGLE_PLACES_API_KEY');
  }
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid latitude');
  }
  if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid longitude');
  }

  const body = {
    textQuery: SERVICE_CATEGORIES[input.category],
    maxResultCount: 20,
    languageCode: input.language === 'ta' ? 'ta' : 'en',
    locationBias: {
      circle: {
        center: { latitude: input.latitude, longitude: input.longitude },
        radius: Math.min(Math.max(input.radius ?? 5000, 500), 20_000),
      },
    },
  };

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const json = (await res.json().catch(() => ({}))) as PlacesResponse;
  if (!res.ok) {
    throw new ApiError(
      502,
      'PLACES_ERROR',
      `Local services provider error: ${json.error?.message ?? res.status}`,
    );
  }

  return (json.places ?? [])
    .filter((place) => place.id && place.displayName?.text)
    .map((place) => ({
      id: place.id!,
      name: place.displayName!.text!,
      address: place.formattedAddress ?? null,
      phone: place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null,
      rating: place.rating ?? null,
      reviewCount: place.userRatingCount ?? 0,
      mapsUrl: place.googleMapsUri ?? null,
      latitude: place.location?.latitude ?? null,
      longitude: place.location?.longitude ?? null,
      reviews: (place.reviews ?? []).slice(0, 3).map((review) => ({
        author: review.authorAttribution?.displayName ?? 'Google user',
        rating: review.rating ?? null,
        text: review.text?.text ?? '',
        when: review.relativePublishTimeDescription ?? '',
      })),
    }));
}
