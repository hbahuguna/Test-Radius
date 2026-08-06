CREATE TABLE "generated_test_scripts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "source_run_id" uuid NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "name" text DEFAULT 'Generated Playwright script' NOT NULL,
  "language" text DEFAULT 'typescript' NOT NULL,
  "framework" text DEFAULT 'playwright' NOT NULL,
  "code" text NOT NULL,
  "description" text,
  "warnings" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generated_test_scripts" ADD CONSTRAINT "generated_test_scripts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generated_test_scripts" ADD CONSTRAINT "generated_test_scripts_source_run_id_agentic_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."agentic_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "generated_test_scripts_source_run_idx" ON "generated_test_scripts" USING btree ("source_run_id", "version");
