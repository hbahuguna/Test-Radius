CREATE TABLE "generated_code_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "script_id" uuid NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "generated_code_runs" ADD CONSTRAINT "generated_code_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generated_code_runs" ADD CONSTRAINT "generated_code_runs_script_id_generated_test_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."generated_test_scripts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "generated_code_runs_user_created_idx" ON "generated_code_runs" USING btree ("user_id", "created_at");
