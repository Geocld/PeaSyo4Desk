import PsGamepadIcon from "./gamepad/PsGamepadIcon";

const MapItem = ({ name, value, onPress }) => {

  const handleClick = () => {
    onPress && onPress(name)
  }

  return (
    <div className='map-item' onClick={handleClick}>
      <div className='left'>
        <PsGamepadIcon action={name} />
      </div>
      <div className='center'>
        <img
          src="/images/gamepad/arrow-right.svg"
          alt="arrow-right"
          width={40}
          height={40}
        />
      </div>
      <div className='right'>{ value }</div>
    </div>
  )
}

export default MapItem
