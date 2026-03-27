import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authConfig } from "@/auth.config";
import SheetsWorkspace from "@/components/SheetsWorkspace";

export default async function SheetsPage() {
  const session = await getServerSession(authConfig);

  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/sheets");
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <SheetsWorkspace userEmail={session.user.email || ""} />
    </main>
  );
}
