import { Link } from "@tanstack/react-router";
import { Alert, AlertTitle } from "@/components/reui/alert";

export default function HomePage() {
  return (
    <main>
      <h1>GotongHR</h1>
      <Alert>
        <AlertTitle>GotongHR</AlertTitle>
      </Alert>
      <nav>
        <Link to="/sign-in">Sign in</Link>
        <Link to="/admin">Admin</Link>
        <a href="/ess">ESS</a>
      </nav>
    </main>
  );
}
