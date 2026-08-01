import {
  Boxes,
  Cloud,
  Container,
  Cpu,
  Database,
  FlaskConical,
  Github,
  Globe,
  HardDrive,
  Layers,
  Lock,
  Mail,
  Network,
  Rocket,
  Server,
  Shield,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Conjunto curado de ícones para conexões.
 *
 * Deliberadamente pequeno: com 20 opções o usuário reconhece o servidor pela
 * forma; com 200 ele só escolhe uma vez e nunca mais lembra qual era.
 */
export const CONNECTION_ICONS: Record<string, LucideIcon> = {
  server: Server,
  database: Database,
  globe: Globe,
  cloud: Cloud,
  container: Container,
  layers: Layers,
  boxes: Boxes,
  cpu: Cpu,
  "hard-drive": HardDrive,
  network: Network,
  shield: Shield,
  lock: Lock,
  rocket: Rocket,
  flask: FlaskConical,
  wrench: Wrench,
  zap: Zap,
  terminal: Terminal,
  mail: Mail,
  github: Github,
};

export const ICON_NAMES = Object.keys(CONNECTION_ICONS);

export function ConnIcon({
  name,
  size = 15,
  color,
}: {
  name: string;
  size?: number;
  color?: string;
}) {
  const Cmp = CONNECTION_ICONS[name] ?? Server;
  return <Cmp size={size} color={color} strokeWidth={2} />;
}
