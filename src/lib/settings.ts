import "server-only";
import { collections, getDb } from "./db";
import type { SettingsDoc } from "./types";

export const SETTINGS_ID = "business";

/**
 * Business configuration lives in the database so the owner can change it without
 * a deploy. Environment variables only seed the first-run defaults — nothing in
 * the UI hardcodes a phone number, UPI ID or price.
 */
export const defaultSettings = (): Omit<SettingsDoc, "_id"> => ({
  businessName: process.env.NEXT_PUBLIC_BUSINESS_NAME || "Cricket Turf Arena",
  supportPhone: (process.env.BUSINESS_PHONE || "").replace(/\D/g, "").slice(-10),
  whatsappNumber: (process.env.BUSINESS_WHATSAPP || process.env.BUSINESS_PHONE || "").replace(/\D/g, "").slice(-10),
  upiId: process.env.UPI_ID || "",
  upiPayeeName: process.env.UPI_PAYEE_NAME || "",
  upiQrImageUrl: process.env.UPI_QR_IMAGE_URL || "",
  // Both default OFF. Every SMS costs the owner money, so nothing sends until
  // they have an account and switch it on deliberately.
  otpEnabled: false,
  // Off until the owner has a Razorpay account they have actually tested. The
  // manual UPI flow is what runs meanwhile, exactly as it always has.
  razorpayEnabled: false,
  // On, because until the gateway is live it is the only way to pay.
  upiScreenshotEnabled: true,
  notifyPhone: "",
  notifyOnNewBooking: false,
  updatedAt: new Date(),
});

export async function getSettings(): Promise<SettingsDoc> {
  const db = await getDb();
  const existing = await collections.settings(db).findOne({ _id: SETTINGS_ID });
  // Merged over the defaults so a settings document saved before a field existed
  // reads as its default rather than as undefined.
  if (existing) return { ...defaultSettings(), ...existing, _id: SETTINGS_ID };
  return { _id: SETTINGS_ID, ...defaultSettings() };
}

export async function saveSettings(patch: Partial<Omit<SettingsDoc, "_id" | "updatedAt">>): Promise<SettingsDoc> {
  const db = await getDb();
  const current = await getSettings();
  const next: SettingsDoc = { ...current, ...patch, _id: SETTINGS_ID, updatedAt: new Date() };
  await collections.settings(db).replaceOne({ _id: SETTINGS_ID }, next, { upsert: true });
  return next;
}
