import { LoginForm } from "./form";

export default function LoginPage() {
  return (
    <div className="max-w-sm">
      <h1 className="text-xl font-semibold mb-4">Log in</h1>
      <LoginForm />
      <p className="mt-4 text-sm text-gray-600">
        Demo users: buyer, operator, farmer-a, farmer-b, farmer-c. Passwords are in your local .env.
      </p>
    </div>
  );
}
