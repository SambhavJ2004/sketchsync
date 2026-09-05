import { z } from "zod";

export const SignupInput = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});
export type SignupInput = z.infer<typeof SignupInput>;

export const SigninInput = z.object({
  email: z.string().email(),
  password: z.string(),
});
export type SigninInput = z.infer<typeof SigninInput>;
