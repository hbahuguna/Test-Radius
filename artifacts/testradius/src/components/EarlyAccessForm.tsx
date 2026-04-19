import React, { useState } from "react";
import { CardContent, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, CheckCircle2, Fingerprint } from "lucide-react";

export function EarlyAccessForm() {
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setStatus("submitting");

    try {
      const formData = new FormData();
      formData.append("access_key", "ebd48112-7ad0-489a-80d0-5b3d0f77c336");
      formData.append("subject", "New Early Access Request — TestRadius");
      formData.append("from_name", "TestRadius Landing Page");
      formData.append("email", email);
      formData.append("company", company || "(not provided)");
      formData.append("role", role || "(not provided)");

      const response = await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      console.log("Web3Forms response:", data);

      if (data.success) {
        setStatus("success");
        setEmail("");
        setCompany("");
        setRole("");
      } else {
        setErrorMsg(data.message || "Unknown error from Web3Forms");
        setStatus("error");
      }
    } catch (error) {
      setErrorMsg(String(error));
      setStatus("error");
    }
  };

  if (status === "success") {
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 size={32} />
        </div>
        <h3 className="text-2xl font-bold mb-2">You're on the list.</h3>
        <p className="text-muted-foreground">
          We'll reach out soon with access details. Thanks for your interest in
          TestRadius.
        </p>
        <Button
          variant="outline"
          className="mt-8"
          onClick={() => setStatus("idle")}
        >
          Submit another
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {status === "error" && (
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm flex items-start gap-3">
          <AlertCircle size={18} className="shrink-0 mt-0.5" />
          <p>
            {errorMsg ||
              "Something went wrong. Please try again or email us directly."}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">
          Work Email <span className="text-red-500">*</span>
        </Label>
        <Input
          id="email"
          type="email"
          placeholder="engineer@company.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-12 bg-background"
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <div className="space-y-2">
          <Label htmlFor="company">
            Company{" "}
            <span className="text-muted-foreground font-normal">
              (Optional)
            </span>
          </Label>
          <Input
            id="company"
            type="text"
            placeholder="Acme Corp"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="h-12 bg-background"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="role">
            Role{" "}
            <span className="text-muted-foreground font-normal">
              (Optional)
            </span>
          </Label>
          <Input
            id="role"
            type="text"
            placeholder="Engineering Manager"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="h-12 bg-background"
          />
        </div>
      </div>

      <div className="pt-4">
        <Button
          type="submit"
          className="w-full h-12 text-base font-medium"
          disabled={status === "submitting" || !email}
        >
          {status === "submitting" ? (
            <span className="flex items-center gap-2">
              <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-foreground"></span>
              Submitting...
            </span>
          ) : (
            "Request Early Access"
          )}
        </Button>
      </div>

      <p className="text-center text-xs text-muted-foreground mt-4 flex items-center justify-center gap-1">
        <Fingerprint size={12} /> We'll never spam you. Only early access
        updates.
      </p>
    </form>
  );
}
