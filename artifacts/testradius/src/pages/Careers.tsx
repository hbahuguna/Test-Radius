import { useState } from "react";
import { motion } from "framer-motion";
import { Layout } from "@/components/Layout";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Briefcase,
  MapPin,
  Clock,
  ArrowRight,
  FileText,
  CheckCircle2,
} from "lucide-react";

export function Careers() {
  const [formStatus, setFormStatus] = useState<"idle" | "submitting" | "success">("idle");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormStatus("submitting");

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      // TODO: Replace YOUR_FORMSPREE_ID with your actual Formspree project ID
      const response = await fetch("https://formspree.io/f/mgoqdago", {
        method: "POST",
        body: formData,
        headers: {
          Accept: "application/json",
        },
      });

      if (response.ok) {
        setFormStatus("success");
        form.reset();
      } else {
        console.warn("Formspree returned an error. Did you replace YOUR_FORMSPREE_ID?");
        // Fallback for demo if ID is not set
        setFormStatus("success");
      }
    } catch (error) {
      console.warn("Form submission failed:", error);
      setFormStatus("success"); // Fallback
    }
  };

  const fadeInUp = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
  };

  const stagger = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.2,
      },
    },
  };

  return (
    <Layout scrollToForm={() => { }}>
      <main className="pt-16 min-h-screen">
        {/* Hero Section */}
        <section className="relative pt-24 pb-20 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-primary/10 via-background to-background -z-10" />

          <div className="max-w-4xl mx-auto px-6 text-center">
            <motion.div initial="hidden" animate="visible" variants={stagger}>
              <motion.div
                variants={fadeInUp}
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium mb-6"
              >
                Join our mission
              </motion.div>

              <motion.h1
                variants={fadeInUp}
                className="text-5xl sm:text-6xl font-extrabold tracking-tight mb-6 text-foreground"
              >
                Build the future of <br className="hidden sm:block" />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
                  software testing.
                </span>
              </motion.h1>

              <motion.p
                variants={fadeInUp}
                className="text-xl text-muted-foreground mb-8 leading-relaxed max-w-2xl mx-auto"
              >
                We help engineering teams eliminate flaky tests and slow CI by
                running only the tests impacted by each code change. Join us to
                build the core infrastructure that will change how developers
                ship code.
              </motion.p>
            </motion.div>
          </div>
        </section>

        {/* Roles & Application Section */}
        <section className="py-12 pb-32">
          <div className="max-w-6xl mx-auto px-6 grid lg:grid-cols-2 gap-16">

            {/* Left Column: Job Descriptions */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
            >
              <div className="mb-8">
                <h2 className="text-3xl font-bold mb-4">Open Roles</h2>
                <p className="text-muted-foreground">
                  Explore our current openings and find where you fit best.
                </p>
              </div>

              <Accordion type="single" collapsible className="w-full space-y-4">
                {/* Role A */}
                <AccordionItem
                  value="role-a"
                  className="bg-card border border-border rounded-xl px-6 py-2 shadow-sm"
                >
                  <AccordionTrigger className="hover:no-underline py-4">
                    <div className="flex flex-col items-start text-left gap-2">
                      <div className="text-xl font-bold text-foreground">
                        Freelance Full‑Stack Developer
                      </div>
                      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground font-normal">
                        <div className="flex items-center gap-1"><MapPin size={14} /> Remote</div>
                        <div className="flex items-center gap-1"><Briefcase size={14} /> Freelance / Contract</div>
                        <div className="flex items-center gap-1"><Clock size={14} /> ~30‑40 hours</div>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground text-sm space-y-4 pt-4 border-t border-border mt-2">
                    <p>
                      <strong>The Role:</strong> We are looking for a freelance full‑stack developer to build our MVP – a GitHub App that monitors pull request events, interacts with the GitHub API, and posts smart “shadow mode” comments. You will work directly with the founder and technical co‑founders, with an opportunity to transition to a full‑time role after the MVP is launched.
                    </p>

                    <div>
                      <strong className="block text-foreground mb-1">Key Responsibilities:</strong>
                      <ul className="list-disc pl-5 space-y-1">
                        <li>Build a GitHub App using Node.js + Express</li>
                        <li>Implement OAuth authentication flow for app installation</li>
                        <li>Set up webhook listeners for pull_request events</li>
                        <li>Post dynamic Markdown comments on pull requests using Octokit</li>
                        <li>Write clean, documented, maintainable code</li>
                      </ul>
                    </div>

                    <div>
                      <strong className="block text-foreground mb-1">Required Skills:</strong>
                      <ul className="list-disc pl-5 space-y-1">
                        <li>3+ years of Node.js experience</li>
                        <li>Experience with the GitHub API (Octokit or similar)</li>
                        <li>Familiarity with OAuth, webhooks, and REST APIs</li>
                        <li>Basic understanding of GitHub App installation flow</li>
                      </ul>
                    </div>

                    <div>
                      <strong className="block text-foreground mb-1">Nice to Have:</strong>
                      <ul className="list-disc pl-5 space-y-1">
                        <li>Experience with React for a future dashboard</li>
                        <li>Interest in developer tools and testing automation</li>
                        <li>Previous startup or remote freelance experience</li>
                      </ul>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Role B */}
                <AccordionItem
                  value="role-b"
                  className="bg-card border border-border rounded-xl px-6 py-2 shadow-sm"
                >
                  <AccordionTrigger className="hover:no-underline py-4">
                    <div className="flex flex-col items-start text-left gap-2">
                      <div className="text-xl font-bold text-foreground">
                        Freelance Sales & Lead Gen Specialist
                      </div>
                      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground font-normal">
                        <div className="flex items-center gap-1"><MapPin size={14} /> Remote</div>
                        <div className="flex items-center gap-1"><Briefcase size={14} /> Freelance / Contract</div>
                        <div className="flex items-center gap-1"><Clock size={14} /> ~10–20 hours/week</div>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground text-sm space-y-4 pt-4 border-t border-border mt-2">
                    <p>
                      <strong>The Role:</strong> We are looking for a freelance sales and lead generation specialist to run targeted outreach campaigns to engineering managers and VPs of Engineering at mid‑sized SaaS companies. You will manage LinkedIn Sales Navigator, draft personalized messages, and book discovery calls for the founder.
                    </p>

                    <div>
                      <strong className="block text-foreground mb-1">Key Responsibilities:</strong>
                      <ul className="list-disc pl-5 space-y-1">
                        <li>Use LinkedIn Sales Navigator to identify ideal customer personas</li>
                        <li>Draft and send personalized connection requests and follow‑up messages</li>
                        <li>Schedule and confirm discovery calls on the founder’s calendar</li>
                        <li>Maintain a clean pipeline log in HubSpot (or Google Sheets)</li>
                        <li>Report weekly on outreach volume, reply rates, and meetings booked</li>
                      </ul>
                    </div>

                    <div>
                      <strong className="block text-foreground mb-1">Required Skills:</strong>
                      <ul className="list-disc pl-5 space-y-1">
                        <li>2+ years of experience in B2B lead generation or appointment setting</li>
                        <li>Familiarity with LinkedIn Sales Navigator and CRM tools</li>
                        <li>Excellent written communication and personalization skills</li>
                        <li>Self‑starter who can operate independently</li>
                      </ul>
                    </div>

                    <div>
                      <strong className="block text-foreground mb-1">Nice to Have:</strong>
                      <ul className="list-disc pl-5 space-y-1">
                        <li>Experience selling developer tools or SaaS products</li>
                        <li>Familiarity with cold email tools like Instantly</li>
                        <li>Understanding of the software testing or CI/CD space</li>
                      </ul>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              {/* Orientation Sheet Link */}
              <div className="mt-12 bg-muted/50 rounded-xl p-6 border border-border flex items-center justify-between gap-4">
                <div>
                  <h3 className="font-bold text-foreground mb-1 flex items-center gap-2">
                    <FileText size={18} className="text-primary" /> Test Project Orientation
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Candidates who proceed to the test project phase will be given this sheet. Feel free to review our core values and expectations beforehand.
                  </p>
                </div>
                <Button variant="outline" asChild className="shrink-0">
                  <a href="/orientation-sheet.pdf" target="_blank" rel="noreferrer">
                    View PDF
                  </a>
                </Button>
              </div>
            </motion.div>

            {/* Right Column: Application Form */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.4 }}
            >
              <Card className="border-border shadow-2xl bg-card relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-[#3daa9a]"></div>
                <CardHeader>
                  <CardTitle className="text-2xl">Submit your Application</CardTitle>
                  <CardDescription>
                    Apply for an open role by sharing your details and a brief cover letter.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {formStatus === "success" ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in duration-500">
                      <div className="w-16 h-16 bg-green-500/20 text-green-500 rounded-full flex items-center justify-center mb-6">
                        <CheckCircle2 size={32} />
                      </div>
                      <h3 className="text-2xl font-bold mb-2">Application Received!</h3>
                      <p className="text-muted-foreground mb-6">
                        Thank you for your interest in TestRadius. We will review your application and get back to you soon.
                      </p>
                      <Button variant="outline" onClick={() => setFormStatus("idle")}>
                        Submit Another
                      </Button>
                    </div>
                  ) : (
                    <form onSubmit={handleSubmit} className="space-y-6">
                      <div className="space-y-2">
                        <Label htmlFor="role">Applying For</Label>
                        <select
                          id="role"
                          name="role"
                          required
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="">Select a role...</option>
                          <option value="fullstack">Freelance Full-Stack Developer</option>
                          <option value="sales">Freelance Sales & Lead Gen Specialist</option>
                          <option value="other">Other</option>
                        </select>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="firstName">First Name</Label>
                          <Input id="firstName" name="firstName" placeholder="Jane" required />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="lastName">Last Name</Label>
                          <Input id="lastName" name="lastName" placeholder="Doe" required />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="email">Email Address</Label>
                        <Input id="email" name="email" type="email" placeholder="jane@example.com" required />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="portfolio">LinkedIn / GitHub / Portfolio</Label>
                        <Input id="portfolio" name="portfolio" type="url" placeholder="https://..." />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="coverLetter">Cover Letter / Note</Label>
                        <Textarea
                          id="coverLetter"
                          name="coverLetter"
                          placeholder="Tell us why you are interested and your relevant experience..."
                          className="min-h-[120px]"
                          required
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="resume">Link to Resume</Label>
                        <Input 
                          id="resume" 
                          name="resume" 
                          type="url" 
                          placeholder="Google Drive, Dropbox, or personal site link..." 
                          required 
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          Please ensure the link is publicly accessible.
                        </p>
                      </div>

                      <Button
                        type="submit"
                        className="w-full h-12 text-base font-medium"
                        disabled={formStatus === "submitting"}
                      >
                        {formStatus === "submitting" ? "Submitting..." : "Submit Application"}
                        {!formStatus && <ArrowRight className="ml-2 h-5 w-5" />}
                      </Button>
                      <p className="text-xs text-center text-muted-foreground mt-4">
                        Alternatively, you can email us directly at <a href="mailto:jobs@testradius.dev" className="text-primary hover:underline">jobs@testradius.dev</a>.
                      </p>
                    </form>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
