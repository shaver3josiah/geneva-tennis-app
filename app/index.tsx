import { Redirect } from 'expo-router';
import { useSession } from '../src/session';
import { Loading } from '../src/ui';

/** The gate. Nothing else in the app has to think about whether a user exists. */
export default function Index() {
  const { user, ready } = useSession();
  if (!ready) return <Loading label="Checking your session…" />;
  return <Redirect href={user ? '/(tabs)' : '/sign-in'} />;
}
