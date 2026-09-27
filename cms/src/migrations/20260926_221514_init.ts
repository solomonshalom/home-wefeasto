import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_products_category" AS ENUM('Flakes', 'Oats', 'Muesli', 'Mix');
  CREATE TYPE "public"."enum_products_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__products_v_version_category" AS ENUM('Flakes', 'Oats', 'Muesli', 'Mix');
  CREATE TYPE "public"."enum__products_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_recipes_products_rating_style" AS ENUM('decimal', 'plain');
  CREATE TYPE "public"."enum_recipes_category" AS ENUM('Breakfast', 'Kids', 'Snacks', 'Desserts');
  CREATE TYPE "public"."enum_recipes_tag_color" AS ENUM('#ff8d5e', '#ffc33a', '#d499eb', '#2cdb69', '#d498eb', 'hsla(141, 70.74%, 51.53%, 1.00)');
  CREATE TYPE "public"."enum_recipes_icon_color" AS ENUM('#ff8d5e', '#ffc33a', '#d499eb', '#2cdb69', '#d498eb', 'hsla(141, 70.74%, 51.53%, 1.00)');
  CREATE TYPE "public"."enum_recipes_icon_src" AS ENUM('/images/626aeef4f317e035c740e924_heart_fill_20_2_.svg', '/images/626aeeee73f41522db4989fb_hamburger_fill.svg', '/images/626aef0610d6909bf9f81543_barbell_fill.svg');
  CREATE TYPE "public"."enum_recipes_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__recipes_v_version_products_rating_style" AS ENUM('decimal', 'plain');
  CREATE TYPE "public"."enum__recipes_v_version_category" AS ENUM('Breakfast', 'Kids', 'Snacks', 'Desserts');
  CREATE TYPE "public"."enum__recipes_v_version_tag_color" AS ENUM('#ff8d5e', '#ffc33a', '#d499eb', '#2cdb69', '#d498eb', 'hsla(141, 70.74%, 51.53%, 1.00)');
  CREATE TYPE "public"."enum__recipes_v_version_icon_color" AS ENUM('#ff8d5e', '#ffc33a', '#d499eb', '#2cdb69', '#d498eb', 'hsla(141, 70.74%, 51.53%, 1.00)');
  CREATE TYPE "public"."enum__recipes_v_version_icon_src" AS ENUM('/images/626aeef4f317e035c740e924_heart_fill_20_2_.svg', '/images/626aeeee73f41522db4989fb_hamburger_fill.svg', '/images/626aef0610d6909bf9f81543_barbell_fill.svg');
  CREATE TYPE "public"."enum__recipes_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_pages_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__pages_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_orders_source" AS ENUM('web', 'usual', 'link', 'email', 'refill', 'offer');
  CREATE TYPE "public"."enum_orders_status" AS ENUM('pending_payment', 'payment_failed', 'paid', 'cod_pending', 'cod_confirmed', 'expired', 'cancelled', 'needs_review', 'refunded', 'partially_refunded');
  CREATE TYPE "public"."enum_orders_payment_status" AS ENUM('none', 'created', 'attempted', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded');
  CREATE TYPE "public"."enum_orders_fulfilment_status" AS ENUM('unfulfilled', 'packed', 'shipped', 'delivered', 'rto', 'returned');
  CREATE TYPE "public"."enum_orders_requested_method" AS ENUM('upi', 'card', 'cod');
  CREATE TYPE "public"."enum_orders_payment_method" AS ENUM('online', 'cod');
  CREATE TYPE "public"."enum_orders_stock_state" AS ENUM('reserved', 'committed', 'released');
  CREATE TYPE "public"."enum_orders_paid_via" AS ENUM('client', 'callback', 'webhook', 'reconcile', 'admin');
  CREATE TYPE "public"."enum_coupons_type" AS ENUM('percent', 'fixed', 'free_delivery');
  CREATE TYPE "public"."enum_coupon_redemptions_status" AS ENUM('reserved', 'consumed', 'released');
  CREATE TYPE "public"."enum_subscribers_status" AS ENUM('pending', 'confirmed', 'unsubscribed');
  CREATE TYPE "public"."enum_message_log_status" AS ENUM('pending', 'sent', 'failed');
  CREATE TYPE "public"."enum_users_role" AS ENUM('admin', 'editor');
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'sendEmail', 'reconcilePendingOrders', 'refillReminder');
  CREATE TYPE "public"."enum_payload_jobs_log_state" AS ENUM('failed', 'succeeded');
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'sendEmail', 'reconcilePendingOrders', 'refillReminder');
  CREATE TABLE "products_partners" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"url" varchar
  );
  
  CREATE TABLE "products" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"slug" varchar,
  	"sort_order" numeric,
  	"name" varchar,
  	"category" "enum_products_category",
  	"price_paise" numeric,
  	"pack_size" varchar,
  	"calories" numeric,
  	"rating" numeric,
  	"rating_source" varchar,
  	"description" varchar,
  	"recipes_heading" varchar,
  	"image" varchar,
  	"image_upload_id" integer,
  	"hero_alt" varchar,
  	"shop_alt" varchar,
  	"home_featured" boolean DEFAULT false,
  	"home_alt" varchar,
  	"in_stock" boolean DEFAULT true,
  	"low_stock_threshold" numeric DEFAULT 5,
  	"stock" numeric DEFAULT 0,
  	"max_per_order" numeric DEFAULT 10,
  	"cod_allowed" boolean DEFAULT true,
  	"pack_grams" numeric,
  	"serving_grams" numeric,
  	"days_per_pack" numeric,
  	"facts_net_quantity" varchar,
  	"facts_ingredients" varchar,
  	"facts_best_before" varchar,
  	"facts_manufacturer" varchar,
  	"facts_country_of_origin" varchar DEFAULT 'India',
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_products_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "products_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "products_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"products_id" integer
  );
  
  CREATE TABLE "_products_v_version_partners" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"url" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_products_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_slug" varchar,
  	"version_sort_order" numeric,
  	"version_name" varchar,
  	"version_category" "enum__products_v_version_category",
  	"version_price_paise" numeric,
  	"version_pack_size" varchar,
  	"version_calories" numeric,
  	"version_rating" numeric,
  	"version_rating_source" varchar,
  	"version_description" varchar,
  	"version_recipes_heading" varchar,
  	"version_image" varchar,
  	"version_image_upload_id" integer,
  	"version_hero_alt" varchar,
  	"version_shop_alt" varchar,
  	"version_home_featured" boolean DEFAULT false,
  	"version_home_alt" varchar,
  	"version_in_stock" boolean DEFAULT true,
  	"version_low_stock_threshold" numeric DEFAULT 5,
  	"version_stock" numeric DEFAULT 0,
  	"version_max_per_order" numeric DEFAULT 10,
  	"version_cod_allowed" boolean DEFAULT true,
  	"version_pack_grams" numeric,
  	"version_serving_grams" numeric,
  	"version_days_per_pack" numeric,
  	"version_facts_net_quantity" varchar,
  	"version_facts_ingredients" varchar,
  	"version_facts_best_before" varchar,
  	"version_facts_manufacturer" varchar,
  	"version_facts_country_of_origin" varchar DEFAULT 'India',
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__products_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  CREATE TABLE "_products_v_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "_products_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"products_id" integer
  );
  
  CREATE TABLE "recipes_products" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"product_id" integer,
  	"rating_style" "enum_recipes_products_rating_style" DEFAULT 'decimal',
  	"alt" varchar
  );
  
  CREATE TABLE "recipes_extras" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"reason" varchar
  );
  
  CREATE TABLE "recipes_recommended" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"reason" varchar
  );
  
  CREATE TABLE "recipes" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"slug" varchar,
  	"sort_order" numeric,
  	"title" varchar,
  	"category" "enum_recipes_category",
  	"description" varchar,
  	"prep_time" varchar,
  	"cook_time" varchar,
  	"serves" varchar,
  	"intro" varchar,
  	"author_bio" varchar,
  	"ingredients_html" varchar,
  	"directions_html" varchar,
  	"why_html" varchar,
  	"image" varchar,
  	"hero_alt" varchar,
  	"card_alt" varchar,
  	"home_featured" boolean DEFAULT false,
  	"home_alt" varchar,
  	"tag_color" "enum_recipes_tag_color",
  	"icon_color" "enum_recipes_icon_color",
  	"icon_src" "enum_recipes_icon_src",
  	"icon_alt" varchar,
  	"extras_heading" varchar,
  	"extras_intro" varchar,
  	"recommended_heading" varchar,
  	"recommended_intro" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_recipes_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "recipes_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "recipes_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"recipes_id" integer
  );
  
  CREATE TABLE "_recipes_v_version_products" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"product_id" integer,
  	"rating_style" "enum__recipes_v_version_products_rating_style" DEFAULT 'decimal',
  	"alt" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_recipes_v_version_extras" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"reason" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_recipes_v_version_recommended" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"reason" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_recipes_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_slug" varchar,
  	"version_sort_order" numeric,
  	"version_title" varchar,
  	"version_category" "enum__recipes_v_version_category",
  	"version_description" varchar,
  	"version_prep_time" varchar,
  	"version_cook_time" varchar,
  	"version_serves" varchar,
  	"version_intro" varchar,
  	"version_author_bio" varchar,
  	"version_ingredients_html" varchar,
  	"version_directions_html" varchar,
  	"version_why_html" varchar,
  	"version_image" varchar,
  	"version_hero_alt" varchar,
  	"version_card_alt" varchar,
  	"version_home_featured" boolean DEFAULT false,
  	"version_home_alt" varchar,
  	"version_tag_color" "enum__recipes_v_version_tag_color",
  	"version_icon_color" "enum__recipes_v_version_icon_color",
  	"version_icon_src" "enum__recipes_v_version_icon_src",
  	"version_icon_alt" varchar,
  	"version_extras_heading" varchar,
  	"version_extras_intro" varchar,
  	"version_recommended_heading" varchar,
  	"version_recommended_intro" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__recipes_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  CREATE TABLE "_recipes_v_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "_recipes_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"recipes_id" integer
  );
  
  CREATE TABLE "pages" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"slug" varchar,
  	"published" boolean DEFAULT false,
  	"sort_order" numeric,
  	"title" varchar,
  	"body_html" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_pages_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_pages_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_slug" varchar,
  	"version_published" boolean DEFAULT false,
  	"version_sort_order" numeric,
  	"version_title" varchar,
  	"version_body_html" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__pages_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  CREATE TABLE "media" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"alt" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric,
  	"focal_x" numeric,
  	"focal_y" numeric
  );
  
  CREATE TABLE "orders_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"product_id" integer,
  	"slug" varchar NOT NULL,
  	"name" varchar NOT NULL,
  	"unit_paise" numeric DEFAULT 0 NOT NULL,
  	"qty" numeric NOT NULL,
  	"line_total_paise" numeric DEFAULT 0 NOT NULL,
  	"image" varchar
  );
  
  CREATE TABLE "orders_razorpay_attempts" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"order_id" varchar NOT NULL,
  	"receipt" varchar NOT NULL,
  	"amount" numeric NOT NULL,
  	"status" varchar,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "orders_razorpay_payments" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"payment_id" varchar NOT NULL,
  	"order_id" varchar,
  	"status" varchar,
  	"method" varchar,
  	"amount" numeric,
  	"error_code" varchar,
  	"error_reason" varchar,
  	"error_description" varchar,
  	"via" varchar,
  	"at" timestamp(3) with time zone
  );
  
  CREATE TABLE "orders_refunds" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"refund_id" varchar,
  	"payment_id" varchar,
  	"amount_paise" numeric NOT NULL,
  	"status" varchar,
  	"reason" varchar,
  	"created_at" timestamp(3) with time zone,
  	"processed_at" timestamp(3) with time zone,
  	"receipt" varchar,
  	"attempts" numeric,
  	"error" varchar
  );
  
  CREATE TABLE "orders_status_history" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"at" timestamp(3) with time zone NOT NULL,
  	"field" varchar NOT NULL,
  	"from" varchar,
  	"to" varchar NOT NULL,
  	"source" varchar,
  	"note" varchar
  );
  
  CREATE TABLE "orders" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"number" varchar NOT NULL,
  	"source" "enum_orders_source" DEFAULT 'web',
  	"token_nonce" varchar,
  	"token_hash" varchar,
  	"request_hash" varchar,
  	"idempotency_key" varchar,
  	"customer_id" integer,
  	"status" "enum_orders_status" DEFAULT 'pending_payment' NOT NULL,
  	"payment_status" "enum_orders_payment_status" DEFAULT 'none' NOT NULL,
  	"fulfilment_status" "enum_orders_fulfilment_status" DEFAULT 'unfulfilled' NOT NULL,
  	"contact_name" varchar NOT NULL,
  	"contact_email" varchar NOT NULL,
  	"contact_phone" varchar NOT NULL,
  	"shipping_address_line1" varchar NOT NULL,
  	"shipping_address_city" varchar NOT NULL,
  	"shipping_address_state" varchar NOT NULL,
  	"shipping_address_pin" varchar NOT NULL,
  	"subtotal_paise" numeric DEFAULT 0 NOT NULL,
  	"discount_paise" numeric DEFAULT 0 NOT NULL,
  	"delivery_paise" numeric DEFAULT 0 NOT NULL,
  	"cod_fee_paise" numeric DEFAULT 0 NOT NULL,
  	"total_paise" numeric DEFAULT 0 NOT NULL,
  	"currency" varchar DEFAULT 'INR' NOT NULL,
  	"coupon_code" varchar,
  	"coupon_discount_paise" numeric,
  	"requested_method" "enum_orders_requested_method" NOT NULL,
  	"payment_method" "enum_orders_payment_method" NOT NULL,
  	"stock_state" "enum_orders_stock_state" DEFAULT 'reserved' NOT NULL,
  	"reserved_until" timestamp(3) with time zone,
  	"paid_at" timestamp(3) with time zone,
  	"paid_via" "enum_orders_paid_via",
  	"confirmation_sent_at" timestamp(3) with time zone,
  	"razorpay_payment_id" varchar,
  	"razorpay_method" varchar,
  	"razorpay_captured_at" timestamp(3) with time zone,
  	"dispute_dispute_id" varchar,
  	"dispute_status" varchar,
  	"dispute_phase" varchar,
  	"dispute_reason_code" varchar,
  	"dispute_amount_paise" numeric,
  	"dispute_at" timestamp(3) with time zone,
  	"reconciled_at" timestamp(3) with time zone,
  	"review_reason" varchar,
  	"consent_marketing" boolean DEFAULT false,
  	"consent_at" timestamp(3) with time zone,
  	"consent_text" varchar,
  	"household_size" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "customers_addresses" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar,
  	"line1" varchar NOT NULL,
  	"city" varchar NOT NULL,
  	"state" varchar NOT NULL,
  	"pin" varchar NOT NULL,
  	"is_default" boolean DEFAULT false
  );
  
  CREATE TABLE "customers_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "customers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"phone" varchar,
  	"marketing_opt_in" boolean DEFAULT false,
  	"marketing_opt_in_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"reset_password_requested_at" timestamp(3) with time zone,
  	"_verified" boolean,
  	"_verificationtoken" varchar,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "coupons" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"code" varchar NOT NULL,
  	"type" "enum_coupons_type" DEFAULT 'percent' NOT NULL,
  	"value" numeric DEFAULT 0 NOT NULL,
  	"max_discount_paise" numeric,
  	"min_subtotal_paise" numeric,
  	"starts_at" timestamp(3) with time zone,
  	"ends_at" timestamp(3) with time zone,
  	"usage_limit" numeric,
  	"used_count" numeric DEFAULT 0 NOT NULL,
  	"per_customer_limit" numeric,
  	"first_order_only" boolean DEFAULT false,
  	"bound_email" varchar,
  	"active" boolean DEFAULT true,
  	"note" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "coupon_redemptions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"coupon_id" integer NOT NULL,
  	"code" varchar NOT NULL,
  	"order_id" integer NOT NULL,
  	"email" varchar NOT NULL,
  	"customer_id" integer,
  	"discount_paise" numeric NOT NULL,
  	"status" "enum_coupon_redemptions_status" DEFAULT 'reserved' NOT NULL,
  	"consumed_at" timestamp(3) with time zone,
  	"released_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payment_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_id" varchar NOT NULL,
  	"event" varchar NOT NULL,
  	"entity_id" varchar,
  	"order_id" integer,
  	"received_at" timestamp(3) with time zone NOT NULL,
  	"processed_at" timestamp(3) with time zone,
  	"outcome" varchar,
  	"raw_sha256" varchar,
  	"payload" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "subscribers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"email" varchar NOT NULL,
  	"status" "enum_subscribers_status" DEFAULT 'pending' NOT NULL,
  	"source" varchar,
  	"consent_text" varchar,
  	"consent_at" timestamp(3) with time zone,
  	"confirm_token_hash" varchar,
  	"confirm_token_expires_at" timestamp(3) with time zone,
  	"confirmed_at" timestamp(3) with time zone,
  	"unsubscribe_token_hash" varchar,
  	"unsubscribed_at" timestamp(3) with time zone,
  	"last_confirm_sent_at" timestamp(3) with time zone,
  	"welcome_coupon_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "message_log" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"type" varchar,
  	"order_id" integer,
  	"to" varchar,
  	"subject" varchar,
  	"status" "enum_message_log_status" DEFAULT 'pending' NOT NULL,
  	"attempts" numeric DEFAULT 0,
  	"sent_at" timestamp(3) with time zone,
  	"error" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "counters" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"value" numeric DEFAULT 0 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "users_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "users" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"role" "enum_users_role" DEFAULT 'editor' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"reset_password_requested_at" timestamp(3) with time zone,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "payload_kv" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload_jobs_log" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"executed_at" timestamp(3) with time zone NOT NULL,
  	"completed_at" timestamp(3) with time zone NOT NULL,
  	"task_slug" "enum_payload_jobs_log_task_slug" NOT NULL,
  	"task_i_d" varchar NOT NULL,
  	"input" jsonb,
  	"output" jsonb,
  	"state" "enum_payload_jobs_log_state" NOT NULL,
  	"error" jsonb
  );
  
  CREATE TABLE "payload_jobs" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"input" jsonb,
  	"completed_at" timestamp(3) with time zone,
  	"total_tried" numeric DEFAULT 0,
  	"has_error" boolean DEFAULT false,
  	"error" jsonb,
  	"task_slug" "enum_payload_jobs_task_slug",
  	"queue" varchar DEFAULT 'default',
  	"wait_until" timestamp(3) with time zone,
  	"processing" boolean DEFAULT false,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"products_id" integer,
  	"recipes_id" integer,
  	"pages_id" integer,
  	"media_id" integer,
  	"orders_id" integer,
  	"customers_id" integer,
  	"coupons_id" integer,
  	"coupon_redemptions_id" integer,
  	"payment_events_id" integer,
  	"subscribers_id" integer,
  	"message_log_id" integer,
  	"counters_id" integer,
  	"users_id" integer
  );
  
  CREATE TABLE "payload_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"customers_id" integer,
  	"users_id" integer
  );
  
  CREATE TABLE "payload_migrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "store_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"free_delivery_threshold_paise" numeric DEFAULT 49900 NOT NULL,
  	"delivery_fee_paise" numeric DEFAULT 4900 NOT NULL,
  	"cod_enabled" boolean DEFAULT true,
  	"cod_max_paise" numeric DEFAULT 200000 NOT NULL,
  	"cod_fee_paise" numeric DEFAULT 0 NOT NULL,
  	"cod_min_subtotal_paise" numeric DEFAULT 0 NOT NULL,
  	"max_order_paise" numeric DEFAULT 5000000 NOT NULL,
  	"top_up_discovery_bias_paise" numeric DEFAULT 5000 NOT NULL,
  	"shipping_promise_text" varchar DEFAULT 'Ships in 1–2 days · delivered in 3–7 days',
  	"announcement_enabled" boolean DEFAULT false,
  	"announcement_text" varchar DEFAULT '',
  	"announcement_href" varchar DEFAULT '',
  	"support_whatsapp_e164" varchar DEFAULT '+919845262777',
  	"welcome_offer_percent" numeric DEFAULT 10 NOT NULL,
  	"welcome_offer_max_discount_paise" numeric DEFAULT 7500 NOT NULL,
  	"welcome_offer_valid_days" numeric DEFAULT 30 NOT NULL,
  	"legal_entity_name" varchar DEFAULT '',
  	"legal_address" varchar DEFAULT '',
  	"legal_fssai_licence" varchar DEFAULT '',
  	"legal_gstin" varchar DEFAULT '',
  	"legal_grievance_officer_name" varchar DEFAULT '',
  	"legal_grievance_officer_designation" varchar DEFAULT '',
  	"legal_grievance_officer_email" varchar DEFAULT '',
  	"legal_grievance_officer_phone" varchar DEFAULT '',
  	"reservation_minutes" numeric DEFAULT 30 NOT NULL,
  	"cod_max_open_per_phone" numeric DEFAULT 2 NOT NULL,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "store_settings_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  ALTER TABLE "products_partners" ADD CONSTRAINT "products_partners_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "products" ADD CONSTRAINT "products_image_upload_id_media_id_fk" FOREIGN KEY ("image_upload_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "products_texts" ADD CONSTRAINT "products_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "products_rels" ADD CONSTRAINT "products_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "products_rels" ADD CONSTRAINT "products_rels_products_fk" FOREIGN KEY ("products_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_products_v_version_partners" ADD CONSTRAINT "_products_v_version_partners_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_products_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_products_v" ADD CONSTRAINT "_products_v_parent_id_products_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_products_v" ADD CONSTRAINT "_products_v_version_image_upload_id_media_id_fk" FOREIGN KEY ("version_image_upload_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_products_v_texts" ADD CONSTRAINT "_products_v_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_products_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_products_v_rels" ADD CONSTRAINT "_products_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_products_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_products_v_rels" ADD CONSTRAINT "_products_v_rels_products_fk" FOREIGN KEY ("products_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "recipes_products" ADD CONSTRAINT "recipes_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "recipes_products" ADD CONSTRAINT "recipes_products_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "recipes_extras" ADD CONSTRAINT "recipes_extras_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "recipes_recommended" ADD CONSTRAINT "recipes_recommended_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "recipes_texts" ADD CONSTRAINT "recipes_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "recipes_rels" ADD CONSTRAINT "recipes_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "recipes_rels" ADD CONSTRAINT "recipes_rels_recipes_fk" FOREIGN KEY ("recipes_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_recipes_v_version_products" ADD CONSTRAINT "_recipes_v_version_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_recipes_v_version_products" ADD CONSTRAINT "_recipes_v_version_products_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_recipes_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_recipes_v_version_extras" ADD CONSTRAINT "_recipes_v_version_extras_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_recipes_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_recipes_v_version_recommended" ADD CONSTRAINT "_recipes_v_version_recommended_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_recipes_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_recipes_v" ADD CONSTRAINT "_recipes_v_parent_id_recipes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."recipes"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_recipes_v_texts" ADD CONSTRAINT "_recipes_v_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_recipes_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_recipes_v_rels" ADD CONSTRAINT "_recipes_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_recipes_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_recipes_v_rels" ADD CONSTRAINT "_recipes_v_rels_recipes_fk" FOREIGN KEY ("recipes_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v" ADD CONSTRAINT "_pages_v_parent_id_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders_items" ADD CONSTRAINT "orders_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders_items" ADD CONSTRAINT "orders_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_razorpay_attempts" ADD CONSTRAINT "orders_razorpay_attempts_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_razorpay_payments" ADD CONSTRAINT "orders_razorpay_payments_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_refunds" ADD CONSTRAINT "orders_refunds_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders_status_history" ADD CONSTRAINT "orders_status_history_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "customers_addresses" ADD CONSTRAINT "customers_addresses_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "customers_sessions" ADD CONSTRAINT "customers_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_welcome_coupon_id_coupons_id_fk" FOREIGN KEY ("welcome_coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "message_log" ADD CONSTRAINT "message_log_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_jobs_log" ADD CONSTRAINT "payload_jobs_log_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."payload_jobs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_products_fk" FOREIGN KEY ("products_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_recipes_fk" FOREIGN KEY ("recipes_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_pages_fk" FOREIGN KEY ("pages_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_orders_fk" FOREIGN KEY ("orders_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_customers_fk" FOREIGN KEY ("customers_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_coupons_fk" FOREIGN KEY ("coupons_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_coupon_redemptions_fk" FOREIGN KEY ("coupon_redemptions_id") REFERENCES "public"."coupon_redemptions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_payment_events_fk" FOREIGN KEY ("payment_events_id") REFERENCES "public"."payment_events"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_subscribers_fk" FOREIGN KEY ("subscribers_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_message_log_fk" FOREIGN KEY ("message_log_id") REFERENCES "public"."message_log"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_counters_fk" FOREIGN KEY ("counters_id") REFERENCES "public"."counters"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_customers_fk" FOREIGN KEY ("customers_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "store_settings_texts" ADD CONSTRAINT "store_settings_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."store_settings"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "products_partners_order_idx" ON "products_partners" USING btree ("_order");
  CREATE INDEX "products_partners_parent_id_idx" ON "products_partners" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "products_slug_idx" ON "products" USING btree ("slug");
  CREATE UNIQUE INDEX "products_sort_order_idx" ON "products" USING btree ("sort_order");
  CREATE INDEX "products_image_upload_idx" ON "products" USING btree ("image_upload_id");
  CREATE INDEX "products_updated_at_idx" ON "products" USING btree ("updated_at");
  CREATE INDEX "products_created_at_idx" ON "products" USING btree ("created_at");
  CREATE INDEX "products__status_idx" ON "products" USING btree ("_status");
  CREATE INDEX "products_texts_order_parent" ON "products_texts" USING btree ("order","parent_id");
  CREATE INDEX "products_rels_order_idx" ON "products_rels" USING btree ("order");
  CREATE INDEX "products_rels_parent_idx" ON "products_rels" USING btree ("parent_id");
  CREATE INDEX "products_rels_path_idx" ON "products_rels" USING btree ("path");
  CREATE INDEX "products_rels_products_id_idx" ON "products_rels" USING btree ("products_id");
  CREATE INDEX "_products_v_version_partners_order_idx" ON "_products_v_version_partners" USING btree ("_order");
  CREATE INDEX "_products_v_version_partners_parent_id_idx" ON "_products_v_version_partners" USING btree ("_parent_id");
  CREATE INDEX "_products_v_parent_idx" ON "_products_v" USING btree ("parent_id");
  CREATE INDEX "_products_v_version_version_slug_idx" ON "_products_v" USING btree ("version_slug");
  CREATE INDEX "_products_v_version_version_sort_order_idx" ON "_products_v" USING btree ("version_sort_order");
  CREATE INDEX "_products_v_version_version_image_upload_idx" ON "_products_v" USING btree ("version_image_upload_id");
  CREATE INDEX "_products_v_version_version_updated_at_idx" ON "_products_v" USING btree ("version_updated_at");
  CREATE INDEX "_products_v_version_version_created_at_idx" ON "_products_v" USING btree ("version_created_at");
  CREATE INDEX "_products_v_version_version__status_idx" ON "_products_v" USING btree ("version__status");
  CREATE INDEX "_products_v_created_at_idx" ON "_products_v" USING btree ("created_at");
  CREATE INDEX "_products_v_updated_at_idx" ON "_products_v" USING btree ("updated_at");
  CREATE INDEX "_products_v_latest_idx" ON "_products_v" USING btree ("latest");
  CREATE INDEX "_products_v_texts_order_parent" ON "_products_v_texts" USING btree ("order","parent_id");
  CREATE INDEX "_products_v_rels_order_idx" ON "_products_v_rels" USING btree ("order");
  CREATE INDEX "_products_v_rels_parent_idx" ON "_products_v_rels" USING btree ("parent_id");
  CREATE INDEX "_products_v_rels_path_idx" ON "_products_v_rels" USING btree ("path");
  CREATE INDEX "_products_v_rels_products_id_idx" ON "_products_v_rels" USING btree ("products_id");
  CREATE INDEX "recipes_products_order_idx" ON "recipes_products" USING btree ("_order");
  CREATE INDEX "recipes_products_parent_id_idx" ON "recipes_products" USING btree ("_parent_id");
  CREATE INDEX "recipes_products_product_idx" ON "recipes_products" USING btree ("product_id");
  CREATE INDEX "recipes_extras_order_idx" ON "recipes_extras" USING btree ("_order");
  CREATE INDEX "recipes_extras_parent_id_idx" ON "recipes_extras" USING btree ("_parent_id");
  CREATE INDEX "recipes_recommended_order_idx" ON "recipes_recommended" USING btree ("_order");
  CREATE INDEX "recipes_recommended_parent_id_idx" ON "recipes_recommended" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "recipes_slug_idx" ON "recipes" USING btree ("slug");
  CREATE UNIQUE INDEX "recipes_sort_order_idx" ON "recipes" USING btree ("sort_order");
  CREATE INDEX "recipes_updated_at_idx" ON "recipes" USING btree ("updated_at");
  CREATE INDEX "recipes_created_at_idx" ON "recipes" USING btree ("created_at");
  CREATE INDEX "recipes__status_idx" ON "recipes" USING btree ("_status");
  CREATE INDEX "recipes_texts_order_parent" ON "recipes_texts" USING btree ("order","parent_id");
  CREATE INDEX "recipes_rels_order_idx" ON "recipes_rels" USING btree ("order");
  CREATE INDEX "recipes_rels_parent_idx" ON "recipes_rels" USING btree ("parent_id");
  CREATE INDEX "recipes_rels_path_idx" ON "recipes_rels" USING btree ("path");
  CREATE INDEX "recipes_rels_recipes_id_idx" ON "recipes_rels" USING btree ("recipes_id");
  CREATE INDEX "_recipes_v_version_products_order_idx" ON "_recipes_v_version_products" USING btree ("_order");
  CREATE INDEX "_recipes_v_version_products_parent_id_idx" ON "_recipes_v_version_products" USING btree ("_parent_id");
  CREATE INDEX "_recipes_v_version_products_product_idx" ON "_recipes_v_version_products" USING btree ("product_id");
  CREATE INDEX "_recipes_v_version_extras_order_idx" ON "_recipes_v_version_extras" USING btree ("_order");
  CREATE INDEX "_recipes_v_version_extras_parent_id_idx" ON "_recipes_v_version_extras" USING btree ("_parent_id");
  CREATE INDEX "_recipes_v_version_recommended_order_idx" ON "_recipes_v_version_recommended" USING btree ("_order");
  CREATE INDEX "_recipes_v_version_recommended_parent_id_idx" ON "_recipes_v_version_recommended" USING btree ("_parent_id");
  CREATE INDEX "_recipes_v_parent_idx" ON "_recipes_v" USING btree ("parent_id");
  CREATE INDEX "_recipes_v_version_version_slug_idx" ON "_recipes_v" USING btree ("version_slug");
  CREATE INDEX "_recipes_v_version_version_sort_order_idx" ON "_recipes_v" USING btree ("version_sort_order");
  CREATE INDEX "_recipes_v_version_version_updated_at_idx" ON "_recipes_v" USING btree ("version_updated_at");
  CREATE INDEX "_recipes_v_version_version_created_at_idx" ON "_recipes_v" USING btree ("version_created_at");
  CREATE INDEX "_recipes_v_version_version__status_idx" ON "_recipes_v" USING btree ("version__status");
  CREATE INDEX "_recipes_v_created_at_idx" ON "_recipes_v" USING btree ("created_at");
  CREATE INDEX "_recipes_v_updated_at_idx" ON "_recipes_v" USING btree ("updated_at");
  CREATE INDEX "_recipes_v_latest_idx" ON "_recipes_v" USING btree ("latest");
  CREATE INDEX "_recipes_v_texts_order_parent" ON "_recipes_v_texts" USING btree ("order","parent_id");
  CREATE INDEX "_recipes_v_rels_order_idx" ON "_recipes_v_rels" USING btree ("order");
  CREATE INDEX "_recipes_v_rels_parent_idx" ON "_recipes_v_rels" USING btree ("parent_id");
  CREATE INDEX "_recipes_v_rels_path_idx" ON "_recipes_v_rels" USING btree ("path");
  CREATE INDEX "_recipes_v_rels_recipes_id_idx" ON "_recipes_v_rels" USING btree ("recipes_id");
  CREATE UNIQUE INDEX "pages_slug_idx" ON "pages" USING btree ("slug");
  CREATE INDEX "pages_sort_order_idx" ON "pages" USING btree ("sort_order");
  CREATE INDEX "pages_updated_at_idx" ON "pages" USING btree ("updated_at");
  CREATE INDEX "pages_created_at_idx" ON "pages" USING btree ("created_at");
  CREATE INDEX "pages__status_idx" ON "pages" USING btree ("_status");
  CREATE INDEX "_pages_v_parent_idx" ON "_pages_v" USING btree ("parent_id");
  CREATE INDEX "_pages_v_version_version_slug_idx" ON "_pages_v" USING btree ("version_slug");
  CREATE INDEX "_pages_v_version_version_sort_order_idx" ON "_pages_v" USING btree ("version_sort_order");
  CREATE INDEX "_pages_v_version_version_updated_at_idx" ON "_pages_v" USING btree ("version_updated_at");
  CREATE INDEX "_pages_v_version_version_created_at_idx" ON "_pages_v" USING btree ("version_created_at");
  CREATE INDEX "_pages_v_version_version__status_idx" ON "_pages_v" USING btree ("version__status");
  CREATE INDEX "_pages_v_created_at_idx" ON "_pages_v" USING btree ("created_at");
  CREATE INDEX "_pages_v_updated_at_idx" ON "_pages_v" USING btree ("updated_at");
  CREATE INDEX "_pages_v_latest_idx" ON "_pages_v" USING btree ("latest");
  CREATE INDEX "media_updated_at_idx" ON "media" USING btree ("updated_at");
  CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");
  CREATE UNIQUE INDEX "media_filename_idx" ON "media" USING btree ("filename");
  CREATE INDEX "orders_items_order_idx" ON "orders_items" USING btree ("_order");
  CREATE INDEX "orders_items_parent_id_idx" ON "orders_items" USING btree ("_parent_id");
  CREATE INDEX "orders_items_product_idx" ON "orders_items" USING btree ("product_id");
  CREATE INDEX "orders_razorpay_attempts_order_idx" ON "orders_razorpay_attempts" USING btree ("_order");
  CREATE INDEX "orders_razorpay_attempts_parent_id_idx" ON "orders_razorpay_attempts" USING btree ("_parent_id");
  CREATE INDEX "orders_razorpay_attempts_order_id_idx" ON "orders_razorpay_attempts" USING btree ("order_id");
  CREATE INDEX "orders_razorpay_payments_order_idx" ON "orders_razorpay_payments" USING btree ("_order");
  CREATE INDEX "orders_razorpay_payments_parent_id_idx" ON "orders_razorpay_payments" USING btree ("_parent_id");
  CREATE INDEX "orders_razorpay_payments_payment_id_idx" ON "orders_razorpay_payments" USING btree ("payment_id");
  CREATE INDEX "orders_refunds_order_idx" ON "orders_refunds" USING btree ("_order");
  CREATE INDEX "orders_refunds_parent_id_idx" ON "orders_refunds" USING btree ("_parent_id");
  CREATE INDEX "orders_refunds_refund_id_idx" ON "orders_refunds" USING btree ("refund_id");
  CREATE INDEX "orders_refunds_receipt_idx" ON "orders_refunds" USING btree ("receipt");
  CREATE INDEX "orders_status_history_order_idx" ON "orders_status_history" USING btree ("_order");
  CREATE INDEX "orders_status_history_parent_id_idx" ON "orders_status_history" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "orders_number_idx" ON "orders" USING btree ("number");
  CREATE UNIQUE INDEX "orders_token_hash_idx" ON "orders" USING btree ("token_hash");
  CREATE UNIQUE INDEX "orders_idempotency_key_idx" ON "orders" USING btree ("idempotency_key");
  CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");
  CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");
  CREATE INDEX "orders_payment_status_idx" ON "orders" USING btree ("payment_status");
  CREATE INDEX "orders_fulfilment_status_idx" ON "orders" USING btree ("fulfilment_status");
  CREATE INDEX "orders_contact_contact_email_idx" ON "orders" USING btree ("contact_email");
  CREATE INDEX "orders_contact_contact_phone_idx" ON "orders" USING btree ("contact_phone");
  CREATE INDEX "orders_shipping_address_shipping_address_pin_idx" ON "orders" USING btree ("shipping_address_pin");
  CREATE INDEX "orders_stock_state_idx" ON "orders" USING btree ("stock_state");
  CREATE INDEX "orders_reserved_until_idx" ON "orders" USING btree ("reserved_until");
  CREATE UNIQUE INDEX "orders_razorpay_razorpay_payment_id_idx" ON "orders" USING btree ("razorpay_payment_id");
  CREATE INDEX "orders_updated_at_idx" ON "orders" USING btree ("updated_at");
  CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");
  CREATE INDEX "customers_addresses_order_idx" ON "customers_addresses" USING btree ("_order");
  CREATE INDEX "customers_addresses_parent_id_idx" ON "customers_addresses" USING btree ("_parent_id");
  CREATE INDEX "customers_sessions_order_idx" ON "customers_sessions" USING btree ("_order");
  CREATE INDEX "customers_sessions_parent_id_idx" ON "customers_sessions" USING btree ("_parent_id");
  CREATE INDEX "customers_updated_at_idx" ON "customers" USING btree ("updated_at");
  CREATE INDEX "customers_created_at_idx" ON "customers" USING btree ("created_at");
  CREATE UNIQUE INDEX "customers_email_idx" ON "customers" USING btree ("email");
  CREATE UNIQUE INDEX "coupons_code_idx" ON "coupons" USING btree ("code");
  CREATE INDEX "coupons_ends_at_idx" ON "coupons" USING btree ("ends_at");
  CREATE INDEX "coupons_bound_email_idx" ON "coupons" USING btree ("bound_email");
  CREATE INDEX "coupons_active_idx" ON "coupons" USING btree ("active");
  CREATE INDEX "coupons_updated_at_idx" ON "coupons" USING btree ("updated_at");
  CREATE INDEX "coupons_created_at_idx" ON "coupons" USING btree ("created_at");
  CREATE INDEX "coupon_redemptions_coupon_idx" ON "coupon_redemptions" USING btree ("coupon_id");
  CREATE INDEX "coupon_redemptions_code_idx" ON "coupon_redemptions" USING btree ("code");
  CREATE UNIQUE INDEX "coupon_redemptions_order_idx" ON "coupon_redemptions" USING btree ("order_id");
  CREATE INDEX "coupon_redemptions_email_idx" ON "coupon_redemptions" USING btree ("email");
  CREATE INDEX "coupon_redemptions_customer_idx" ON "coupon_redemptions" USING btree ("customer_id");
  CREATE INDEX "coupon_redemptions_status_idx" ON "coupon_redemptions" USING btree ("status");
  CREATE INDEX "coupon_redemptions_updated_at_idx" ON "coupon_redemptions" USING btree ("updated_at");
  CREATE INDEX "coupon_redemptions_created_at_idx" ON "coupon_redemptions" USING btree ("created_at");
  CREATE UNIQUE INDEX "payment_events_event_id_idx" ON "payment_events" USING btree ("event_id");
  CREATE INDEX "payment_events_event_idx" ON "payment_events" USING btree ("event");
  CREATE INDEX "payment_events_entity_id_idx" ON "payment_events" USING btree ("entity_id");
  CREATE INDEX "payment_events_order_idx" ON "payment_events" USING btree ("order_id");
  CREATE INDEX "payment_events_outcome_idx" ON "payment_events" USING btree ("outcome");
  CREATE INDEX "payment_events_updated_at_idx" ON "payment_events" USING btree ("updated_at");
  CREATE INDEX "payment_events_created_at_idx" ON "payment_events" USING btree ("created_at");
  CREATE UNIQUE INDEX "subscribers_email_idx" ON "subscribers" USING btree ("email");
  CREATE INDEX "subscribers_status_idx" ON "subscribers" USING btree ("status");
  CREATE INDEX "subscribers_confirm_token_hash_idx" ON "subscribers" USING btree ("confirm_token_hash");
  CREATE INDEX "subscribers_unsubscribe_token_hash_idx" ON "subscribers" USING btree ("unsubscribe_token_hash");
  CREATE INDEX "subscribers_welcome_coupon_idx" ON "subscribers" USING btree ("welcome_coupon_id");
  CREATE INDEX "subscribers_updated_at_idx" ON "subscribers" USING btree ("updated_at");
  CREATE INDEX "subscribers_created_at_idx" ON "subscribers" USING btree ("created_at");
  CREATE UNIQUE INDEX "message_log_key_idx" ON "message_log" USING btree ("key");
  CREATE INDEX "message_log_type_idx" ON "message_log" USING btree ("type");
  CREATE INDEX "message_log_order_idx" ON "message_log" USING btree ("order_id");
  CREATE INDEX "message_log_status_idx" ON "message_log" USING btree ("status");
  CREATE INDEX "message_log_updated_at_idx" ON "message_log" USING btree ("updated_at");
  CREATE INDEX "message_log_created_at_idx" ON "message_log" USING btree ("created_at");
  CREATE UNIQUE INDEX "counters_name_idx" ON "counters" USING btree ("name");
  CREATE INDEX "counters_updated_at_idx" ON "counters" USING btree ("updated_at");
  CREATE INDEX "counters_created_at_idx" ON "counters" USING btree ("created_at");
  CREATE INDEX "users_sessions_order_idx" ON "users_sessions" USING btree ("_order");
  CREATE INDEX "users_sessions_parent_id_idx" ON "users_sessions" USING btree ("_parent_id");
  CREATE INDEX "users_updated_at_idx" ON "users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");
  CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_jobs_log_order_idx" ON "payload_jobs_log" USING btree ("_order");
  CREATE INDEX "payload_jobs_log_parent_id_idx" ON "payload_jobs_log" USING btree ("_parent_id");
  CREATE INDEX "payload_jobs_completed_at_idx" ON "payload_jobs" USING btree ("completed_at");
  CREATE INDEX "payload_jobs_total_tried_idx" ON "payload_jobs" USING btree ("total_tried");
  CREATE INDEX "payload_jobs_has_error_idx" ON "payload_jobs" USING btree ("has_error");
  CREATE INDEX "payload_jobs_task_slug_idx" ON "payload_jobs" USING btree ("task_slug");
  CREATE INDEX "payload_jobs_queue_idx" ON "payload_jobs" USING btree ("queue");
  CREATE INDEX "payload_jobs_wait_until_idx" ON "payload_jobs" USING btree ("wait_until");
  CREATE INDEX "payload_jobs_processing_idx" ON "payload_jobs" USING btree ("processing");
  CREATE INDEX "payload_jobs_updated_at_idx" ON "payload_jobs" USING btree ("updated_at");
  CREATE INDEX "payload_jobs_created_at_idx" ON "payload_jobs" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_products_id_idx" ON "payload_locked_documents_rels" USING btree ("products_id");
  CREATE INDEX "payload_locked_documents_rels_recipes_id_idx" ON "payload_locked_documents_rels" USING btree ("recipes_id");
  CREATE INDEX "payload_locked_documents_rels_pages_id_idx" ON "payload_locked_documents_rels" USING btree ("pages_id");
  CREATE INDEX "payload_locked_documents_rels_media_id_idx" ON "payload_locked_documents_rels" USING btree ("media_id");
  CREATE INDEX "payload_locked_documents_rels_orders_id_idx" ON "payload_locked_documents_rels" USING btree ("orders_id");
  CREATE INDEX "payload_locked_documents_rels_customers_id_idx" ON "payload_locked_documents_rels" USING btree ("customers_id");
  CREATE INDEX "payload_locked_documents_rels_coupons_id_idx" ON "payload_locked_documents_rels" USING btree ("coupons_id");
  CREATE INDEX "payload_locked_documents_rels_coupon_redemptions_id_idx" ON "payload_locked_documents_rels" USING btree ("coupon_redemptions_id");
  CREATE INDEX "payload_locked_documents_rels_payment_events_id_idx" ON "payload_locked_documents_rels" USING btree ("payment_events_id");
  CREATE INDEX "payload_locked_documents_rels_subscribers_id_idx" ON "payload_locked_documents_rels" USING btree ("subscribers_id");
  CREATE INDEX "payload_locked_documents_rels_message_log_id_idx" ON "payload_locked_documents_rels" USING btree ("message_log_id");
  CREATE INDEX "payload_locked_documents_rels_counters_id_idx" ON "payload_locked_documents_rels" USING btree ("counters_id");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_customers_id_idx" ON "payload_preferences_rels" USING btree ("customers_id");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");
  CREATE INDEX "store_settings_texts_order_parent" ON "store_settings_texts" USING btree ("order","parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "products_partners" CASCADE;
  DROP TABLE "products" CASCADE;
  DROP TABLE "products_texts" CASCADE;
  DROP TABLE "products_rels" CASCADE;
  DROP TABLE "_products_v_version_partners" CASCADE;
  DROP TABLE "_products_v" CASCADE;
  DROP TABLE "_products_v_texts" CASCADE;
  DROP TABLE "_products_v_rels" CASCADE;
  DROP TABLE "recipes_products" CASCADE;
  DROP TABLE "recipes_extras" CASCADE;
  DROP TABLE "recipes_recommended" CASCADE;
  DROP TABLE "recipes" CASCADE;
  DROP TABLE "recipes_texts" CASCADE;
  DROP TABLE "recipes_rels" CASCADE;
  DROP TABLE "_recipes_v_version_products" CASCADE;
  DROP TABLE "_recipes_v_version_extras" CASCADE;
  DROP TABLE "_recipes_v_version_recommended" CASCADE;
  DROP TABLE "_recipes_v" CASCADE;
  DROP TABLE "_recipes_v_texts" CASCADE;
  DROP TABLE "_recipes_v_rels" CASCADE;
  DROP TABLE "pages" CASCADE;
  DROP TABLE "_pages_v" CASCADE;
  DROP TABLE "media" CASCADE;
  DROP TABLE "orders_items" CASCADE;
  DROP TABLE "orders_razorpay_attempts" CASCADE;
  DROP TABLE "orders_razorpay_payments" CASCADE;
  DROP TABLE "orders_refunds" CASCADE;
  DROP TABLE "orders_status_history" CASCADE;
  DROP TABLE "orders" CASCADE;
  DROP TABLE "customers_addresses" CASCADE;
  DROP TABLE "customers_sessions" CASCADE;
  DROP TABLE "customers" CASCADE;
  DROP TABLE "coupons" CASCADE;
  DROP TABLE "coupon_redemptions" CASCADE;
  DROP TABLE "payment_events" CASCADE;
  DROP TABLE "subscribers" CASCADE;
  DROP TABLE "message_log" CASCADE;
  DROP TABLE "counters" CASCADE;
  DROP TABLE "users_sessions" CASCADE;
  DROP TABLE "users" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_jobs_log" CASCADE;
  DROP TABLE "payload_jobs" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TABLE "store_settings" CASCADE;
  DROP TABLE "store_settings_texts" CASCADE;
  DROP TYPE "public"."enum_products_category";
  DROP TYPE "public"."enum_products_status";
  DROP TYPE "public"."enum__products_v_version_category";
  DROP TYPE "public"."enum__products_v_version_status";
  DROP TYPE "public"."enum_recipes_products_rating_style";
  DROP TYPE "public"."enum_recipes_category";
  DROP TYPE "public"."enum_recipes_tag_color";
  DROP TYPE "public"."enum_recipes_icon_color";
  DROP TYPE "public"."enum_recipes_icon_src";
  DROP TYPE "public"."enum_recipes_status";
  DROP TYPE "public"."enum__recipes_v_version_products_rating_style";
  DROP TYPE "public"."enum__recipes_v_version_category";
  DROP TYPE "public"."enum__recipes_v_version_tag_color";
  DROP TYPE "public"."enum__recipes_v_version_icon_color";
  DROP TYPE "public"."enum__recipes_v_version_icon_src";
  DROP TYPE "public"."enum__recipes_v_version_status";
  DROP TYPE "public"."enum_pages_status";
  DROP TYPE "public"."enum__pages_v_version_status";
  DROP TYPE "public"."enum_orders_source";
  DROP TYPE "public"."enum_orders_status";
  DROP TYPE "public"."enum_orders_payment_status";
  DROP TYPE "public"."enum_orders_fulfilment_status";
  DROP TYPE "public"."enum_orders_requested_method";
  DROP TYPE "public"."enum_orders_payment_method";
  DROP TYPE "public"."enum_orders_stock_state";
  DROP TYPE "public"."enum_orders_paid_via";
  DROP TYPE "public"."enum_coupons_type";
  DROP TYPE "public"."enum_coupon_redemptions_status";
  DROP TYPE "public"."enum_subscribers_status";
  DROP TYPE "public"."enum_message_log_status";
  DROP TYPE "public"."enum_users_role";
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  DROP TYPE "public"."enum_payload_jobs_log_state";
  DROP TYPE "public"."enum_payload_jobs_task_slug";`)
}
