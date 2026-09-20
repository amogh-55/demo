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
  updatedAt: new Date(),
});

export async function getSettings(): Promise<SettingsDoc> {
  const db = await getDb();
  const existing = await collections.settings(db).findOne({ _id: SETTINGS_ID });
  if (existing) return existing;
  return { _id: SETTINGS_ID, ...defaultSettings() };
}

export async function saveSettings(patch: Partial<Omit<SettingsDoc, "_id" | "updatedAt">>): Promise<SettingsDoc> {
  const db = await getDb();
  const current = await getSettings();
  const next: SettingsDoc = { ...current, ...patch, _id: SETTINGS_ID, updatedAt: new Date() };
  await collections.settings(db).replaceOne({ _id: SETTINGS_ID }, next, { upsert: true });
  return next;
}
