import logoImg from "../../img/test2.png";

export default function Logo() {
  return (
    <div className="brand-logo" aria-label="Revolver">
      <img src={logoImg} alt="" className="brand-logo-img" />
    </div>
  );
}
