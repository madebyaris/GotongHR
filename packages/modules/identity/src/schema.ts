import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Better Auth field names stay camelCase. SQL names are snake_case and match
 * the statements in migrate.ts. Object keys are the Better Auth model names.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

export const baUser = pgTable("ba_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
});

export const baSession = pgTable("ba_session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => baUser.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
});

export const baAccount = pgTable(
  "ba_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => baUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("ba_account_provider_account_uidx").on(table.providerId, table.accountId),
  ],
);

export const baVerification = pgTable("ba_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const baOrganization = pgTable("ba_organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: createdAt(),
  metadata: text("metadata"),
});

export const baMember = pgTable("ba_member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => baOrganization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => baUser.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: createdAt(),
});

export const baInvitation = pgTable("ba_invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => baOrganization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => baUser.id, { onDelete: "cascade" }),
});

export const baTwoFactor = pgTable("ba_two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => baUser.id, { onDelete: "cascade" }),
  verified: boolean("verified").default(false),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
});

export const authSchema = {
  user: baUser,
  session: baSession,
  account: baAccount,
  verification: baVerification,
  organization: baOrganization,
  member: baMember,
  invitation: baInvitation,
  twoFactor: baTwoFactor,
};
