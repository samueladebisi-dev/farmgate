"use client";
import { useActionState } from "react";
import { loginAction } from "../actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Username
        <input name="username" autoComplete="username" required className="border px-3 py-2 text-base" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input name="password" type="password" autoComplete="current-password" required className="border px-3 py-2 text-base" />
      </label>
      {state?.error && (
        <p role="alert" className="text-red-700 text-sm">
          {state.error}
        </p>
      )}
      <button disabled={pending} className="border-2 border-black px-3 py-2 font-medium">
        {pending ? "Signing in..." : "Log in"}
      </button>
    </form>
  );
}
