import dns from 'node:dns';
import net from 'node:net';

// 이 인프라는 IPv6 라우팅이 죽어있어 Node의 Happy Eyeballs(autoSelectFamily)가 타임아웃 나는
// 문제가 있음(/app/DEVELOPMENT.md "알려진 함정" 참고, trend-cardnews의 netfix.js와 동일 패턴).
// R2 업로드/이메일 SMTP 등 외부로 나가는 연결 전에 반드시 이 모듈을 먼저 import할 것.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);
