import { notFound } from "next/navigation";
import { SigningProbe } from "../../../components/SigningProbe";

export default function SigningProbePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SigningProbe />;
}
